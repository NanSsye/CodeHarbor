package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

type peer struct {
	conn          *websocket.Conn
	kind          string
	remoteIP      string
	deviceID      string
	ownerUser     string
	authTokenHash string
	presenceToken string
	subscriptions map[string]bool
	outbound      chan []byte
	outboundBytes atomic.Int64
	closed        chan struct{}
	closeOnce     sync.Once
}
type pendingProxy struct {
	browser   *peer
	deviceID  string
	ownerUser string
	timer     *time.Timer
}
type relay struct {
	mu          sync.RWMutex
	browsers    map[*peer]struct{}
	devices     map[string]*peer
	devicePeers map[*peer]struct{}
	pending     map[string]*pendingProxy
	store       *store
	redis       *redis.Client
}

var upgrader = websocket.Upgrader{CheckOrigin: func(req *http.Request) bool {
	allowed := strings.TrimSpace(os.Getenv("CODEHARBOR_ALLOWED_ORIGIN"))
	origin := strings.TrimSpace(req.Header.Get("Origin"))
	if os.Getenv("NODE_ENV") == "production" {
		// Production browser and device sockets must present the one origin
		// configured at the reverse proxy. An empty configured origin must never
		// turn a missing Origin header into an implicit allow.
		return allowed != "" && origin == allowed
	}
	return allowed == "" || origin == allowed
}}

const wsMessageLimit = 16 << 20
const wsIdleTimeout = 90 * time.Second
const deviceHandshakeTimeout = 15 * time.Second
const deviceLeaseTTL = 45 * time.Second
const wsWriteTimeout = 10 * time.Second
const pendingProxyTimeout = 60 * time.Second
const peerOutboundBuffer = 256
const maxPeerSubscriptions = 64
const maxBrowserConnectionsPerUser = 8
const maxDeviceConnectionsTotal = 4096
const maxDeviceConnectionsPerIP = 64
const maxPendingProxyPerBrowser = 128

// A resume frame is supplied by an authenticated browser, but it is still
// untrusted input. Bound the number of session cursors one frame can fan out
// into database reads and socket writes.
const maxResumeSessions = 512

// A message is capped by wsMessageLimit, so a count-only queue could retain
// several GiB per slow client. Bound queued bytes as well as message count.
const maxPeerOutboundBytes = 32 << 20
const gatewayEventsChannel = "codeharbor:gateway-events"
const proxyRequestsChannel = "codeharbor:proxy-requests"
const proxyResponsesChannel = "codeharbor:proxy-responses"
const authRevocationsChannel = "codeharbor:auth-revocations"
const deviceOwnershipChannel = "codeharbor:device-ownership"
const redisOperationTimeout = 3 * time.Second
const relayStorageOperationTimeout = 15 * time.Second

func redisOperationContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), redisOperationTimeout)
}

func redisRequestContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, redisOperationTimeout)
}

func relayStorageContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), relayStorageOperationTimeout)
}

func newPeer(conn *websocket.Conn, kind string) *peer {
	p := &peer{
		conn:          conn,
		kind:          kind,
		subscriptions: map[string]bool{},
		outbound:      make(chan []byte, peerOutboundBuffer),
		closed:        make(chan struct{}),
	}
	if token, err := randomToken(); err == nil {
		p.presenceToken = token
	} else {
		// Only used if the OS random source fails; keep a process-local fallback
		// rather than accepting an empty lease value.
		p.presenceToken = fmt.Sprintf("%p", p)
	}
	go p.writeLoop()
	return p
}

func (p *peer) stop() {
	p.closeOnce.Do(func() {
		close(p.closed)
		if p.conn != nil {
			_ = p.conn.Close()
		}
	})
}

func (r *relay) serveBrowser(w http.ResponseWriter, req *http.Request) {
	user, ok := r.browserPrincipal(req)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	c, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(wsMessageLimit)
	_ = c.SetReadDeadline(time.Now().Add(wsIdleTimeout))
	c.SetPongHandler(func(string) error { return c.SetReadDeadline(time.Now().Add(wsIdleTimeout)) })
	p := newPeer(c, "browser")
	p.ownerUser = user
	if token := browserRequestToken(req); token != "" {
		p.authTokenHash = hex.EncodeToString(hashCredential(token))
	}
	r.mu.Lock()
	connections := 0
	for browser := range r.browsers {
		if browser.ownerUser == user {
			connections++
		}
	}
	if connections >= maxBrowserConnectionsPerUser {
		r.mu.Unlock()
		_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "too many browser connections"), time.Now().Add(time.Second))
		_ = c.Close()
		return
	}
	r.browsers[p] = struct{}{}
	r.mu.Unlock()
	defer r.remove(p)
	p.sendJSON(map[string]any{"type": "cloud-ready", "payload": map[string]any{"protocolVersion": "codeharbor.gateway.v1"}})
	r.readBrowser(p)
}

// authorizedBrowserWS accepts the signed session token issued by the
// login endpoint. Browsers cannot set an Authorization header when creating a
// WebSocket, so they pass that token as ?token=. Keep the legacy fixed cloud
// token on the Authorization header for existing non-browser clients.
func authorizedBrowserWS(req *http.Request) bool {
	_, ok := browserPrincipal(req)
	return ok
}

func browserPrincipal(req *http.Request) (string, bool) {
	// New browsers carry the signed token in a WebSocket subprotocol instead
	// of the URL query string, keeping credentials out of reverse-proxy URLs
	// and access logs. Keep query/header parsing for older clients during the
	// migration window.
	for _, raw := range strings.Split(req.Header.Get("Sec-WebSocket-Protocol"), ",") {
		protocol := strings.TrimSpace(raw)
		if strings.HasPrefix(protocol, "codeharbor-v1.") {
			if user, ok := tokenUser("Bearer " + strings.TrimPrefix(protocol, "codeharbor-v1.")); ok {
				return user, true
			}
		}
	}
	if values, exists := req.URL.Query()["token"]; exists && browserQueryTokenAllowed() {
		if len(values) != 1 {
			return "", false
		}
		token := strings.TrimSpace(values[0])
		if user, ok := tokenUser("Bearer " + token); ok {
			return user, true
		}
	}
	if user, ok := tokenUser(req.Header.Get("Authorization")); ok {
		return user, true
	}
	if cookie, err := req.Cookie(accountCookieName); err == nil {
		if user, ok := tokenUser("Bearer " + cookie.Value); ok {
			return user, true
		}
	}
	if cloudToken := os.Getenv("CODEHARBOR_CLOUD_TOKEN"); cloudToken != "" && req.Header.Get("Authorization") == "Bearer "+cloudToken {
		user := configuredAdminUser()
		if user == "" {
			return "", false
		}
		return user, true
	}
	return "", false
}

func (r *relay) browserPrincipal(req *http.Request) (string, bool) {
	user, ok := browserPrincipal(req)
	if !ok {
		return "", false
	}
	token := browserRequestToken(req)
	if token == "" || token == os.Getenv("CODEHARBOR_CLOUD_TOKEN") || r.redis == nil {
		return user, true
	}
	revoked, err := r.sharedTokenRevoked(req.Context(), token)
	if err != nil || revoked {
		return "", false
	}
	return user, true
}

func browserRequestToken(req *http.Request) string {
	for _, raw := range strings.Split(req.Header.Get("Sec-WebSocket-Protocol"), ",") {
		protocol := strings.TrimSpace(raw)
		if strings.HasPrefix(protocol, "codeharbor-v1.") {
			return strings.TrimSpace(strings.TrimPrefix(protocol, "codeharbor-v1."))
		}
	}
	if values, exists := req.URL.Query()["token"]; exists && browserQueryTokenAllowed() && len(values) == 1 {
		return strings.TrimSpace(values[0])
	}
	return authenticatedRequestToken(req)
}

func browserQueryTokenAllowed() bool {
	if os.Getenv("NODE_ENV") != "production" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(os.Getenv("CODEHARBOR_ALLOW_QUERY_TOKEN")), "true")
}

func (r *relay) readBrowser(p *peer) {
	for {
		var msg map[string]any
		if err := p.conn.ReadJSON(&msg); err != nil {
			return
		}
		_ = p.conn.SetReadDeadline(time.Now().Add(wsIdleTimeout))
		if msg["type"] == "ping" {
			p.sendJSON(map[string]any{"type": "pong", "timestamp": time.Now().UTC().Format(time.RFC3339Nano)})
			continue
		}
		if msg["type"] == "resume" {
			r.resumeBrowser(p, msg)
			continue
		}
		if msg["type"] != "gateway-proxy" {
			if msg["type"] == "subscribe" {
				if id, ok := msg["deviceId"].(string); ok {
					storageCtx, cancelStorage := relayStorageContext()
					device, err := r.store.device(storageCtx, id)
					cancelStorage()
					if err != nil || device.OwnerUser != p.ownerUser {
						continue
					}
					r.mu.Lock()
					if replace, _ := msg["replace"].(bool); replace {
						p.subscriptions = map[string]bool{}
					}
					if !p.subscriptions[id] && len(p.subscriptions) >= maxPeerSubscriptions {
						r.mu.Unlock()
						continue
					}
					p.subscriptions[id] = true
					r.mu.Unlock()
				}
				continue
			}
			continue
		}
		deviceID, _ := msg["deviceId"].(string)
		requestID, _ := msg["requestId"].(string)
		storageCtx, cancelStorage := relayStorageContext()
		device, err := r.store.device(storageCtx, deviceID)
		cancelStorage()
		if err != nil || device.OwnerUser != p.ownerUser {
			p.sendJSON(map[string]any{"type": "gateway-proxy-response", "requestId": requestID, "status": http.StatusForbidden, "error": "forbidden"})
			continue
		}
		if requestID == "" {
			p.sendJSON(map[string]any{"type": "gateway-proxy-response", "status": http.StatusBadRequest, "error": "request_id_required"})
			continue
		}
		r.mu.Lock()
		pendingForBrowser := 0
		for _, current := range r.pending {
			if current.browser == p {
				pendingForBrowser++
			}
		}
		if pendingForBrowser >= maxPendingProxyPerBrowser {
			r.mu.Unlock()
			p.sendJSON(map[string]any{"type": "gateway-proxy-response", "requestId": requestID, "status": http.StatusTooManyRequests, "error": "too_many_pending_requests"})
			continue
		}
		d := r.devices[deviceID]
		if d != nil && !r.deviceLeaseOwned(d) {
			if current := r.devices[deviceID]; current == d {
				delete(r.devices, deviceID)
			}
			d.stop()
			d = nil
		}
		if r.pending[requestID] != nil {
			r.mu.Unlock()
			p.sendJSON(map[string]any{"type": "gateway-proxy-response", "requestId": requestID, "status": http.StatusConflict, "error": "duplicate_request_id"})
			continue
		}
		pending := &pendingProxy{browser: p, deviceID: deviceID, ownerUser: p.ownerUser}
		pending.timer = time.AfterFunc(pendingProxyTimeout, func() {
			r.mu.Lock()
			if current := r.pending[requestID]; current == pending {
				delete(r.pending, requestID)
			}
			r.mu.Unlock()
			p.sendJSON(map[string]any{"type": "gateway-proxy-response", "requestId": requestID, "status": http.StatusGatewayTimeout, "error": "proxy_timeout"})
		})
		r.pending[requestID] = pending
		r.mu.Unlock()
		msg["type"] = "proxy-request"
		if d != nil {
			d.sendJSON(msg)
			continue
		}
		if r.redis != nil {
			if err := r.publish(proxyRequestsChannel, map[string]any{"deviceId": deviceID, "ownerUser": p.ownerUser, "requestId": requestID, "payload": msg}); err == nil {
				continue
			}
		}
		r.mu.Lock()
		delete(r.pending, requestID)
		r.mu.Unlock()
		pending.timer.Stop()
		p.sendJSON(map[string]any{"type": "gateway-proxy-response", "requestId": requestID, "status": 503, "error": "device_offline"})
	}
}

func (r *relay) resumeBrowser(p *peer, msg map[string]any) {
	cursors, ok := msg["cursors"].(map[string]any)
	if !ok {
		p.sendJSON(map[string]any{"type": "resume-complete", "payload": map[string]any{"cursors": map[string]int64{}}})
		return
	}
	latest := make(map[string]int64, len(cursors))
	truncated := false
	processed := 0
	replayDeadline := time.Now().Add(30 * time.Second)
	storageCtx, cancelStorage := relayStorageContext()
	defer cancelStorage()
	for sessionID, rawCursor := range cursors {
		if processed >= maxResumeSessions {
			truncated = true
			break
		}
		processed++
		if len(sessionID) == 0 || len(sessionID) > 256 {
			truncated = true
			continue
		}
		cursor := int64(0)
		switch value := rawCursor.(type) {
		case float64:
			if value >= 0 && value <= float64(^uint64(0)>>1) && math.Trunc(value) == value {
				cursor = int64(value)
			} else {
				truncated = true
				continue
			}
		case int64:
			if value >= 0 {
				cursor = value
			} else {
				truncated = true
				continue
			}
		default:
			truncated = true
			continue
		}
		latest[sessionID] = cursor
		if cursor > 0 {
			if first, last, boundsErr := r.store.eventBoundsForUser(storageCtx, sessionID, p.ownerUser); boundsErr == nil && first > cursor+1 {
				// Retention may have removed the prefix. Tell the client exactly
				// where the retained history starts so it can advance its cursor
				// instead of retrying the same impossible gap forever.
				p.sendJSON(map[string]any{"type": "history-gap", "payload": map[string]any{
					"sessionId": sessionID, "requestedCursor": cursor, "availableFrom": first, "latestCursor": last,
				}})
				latest[sessionID] = first - 1
				cursor = first - 1
			}
		}
		for batch := 0; batch < 5; batch++ {
			// Ask for a sentinel row. Without it, exactly-full final batches are
			// indistinguishable from a history that still has more rows.
			events, err := r.store.listEventsForUserLimited(storageCtx, sessionID, p.ownerUser, latest[sessionID], 1001)
			if err != nil {
				truncated = true
				break
			}
			if len(events) == 0 {
				break
			}
			hasMore := len(events) > 1000
			if hasMore {
				events = events[:1000]
			}
			for _, event := range events {
				if !p.sendJSONBlockingUntil(event, replayDeadline) {
					truncated = true
					break
				}
				if seq, ok := event["eventSeq"].(int64); ok && seq > latest[sessionID] {
					latest[sessionID] = seq
				} else if seq, ok := event["eventSeq"].(float64); ok && int64(seq) > latest[sessionID] {
					latest[sessionID] = int64(seq)
				}
			}
			if truncated || hasMore || batch == 4 {
				truncated = true
				break
			}
		}
	}
	// The replay itself uses the bounded blocking queue.  Its terminal control
	// frame must use the same path: a non-blocking send here can observe the
	// still-full replay queue, close the socket, and discard events that were
	// already accepted for delivery.
	p.sendJSONBlockingUntil(map[string]any{"type": "resume-complete", "payload": map[string]any{"cursors": latest, "truncated": truncated}}, replayDeadline)
}

func (r *relay) serveDevice(w http.ResponseWriter, req *http.Request) {
	c, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(wsMessageLimit)
	_ = c.SetReadDeadline(time.Now().Add(wsIdleTimeout))
	c.SetPongHandler(func(string) error { return c.SetReadDeadline(time.Now().Add(wsIdleTimeout)) })
	p := newPeer(c, "device")
	p.remoteIP = requestIP(req)
	if !r.admitDevicePeer(p) {
		_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "too many device connections"), time.Now().Add(time.Second))
		p.stop()
		return
	}
	defer func() {
		r.mu.Lock()
		delete(r.devicePeers, p)
		r.mu.Unlock()
		r.remove(p)
	}()
	authenticated := false
	_ = c.SetReadDeadline(time.Now().Add(deviceHandshakeTimeout))
	for {
		var msg map[string]any
		if err := c.ReadJSON(&msg); err != nil {
			return
		}
		_ = c.SetReadDeadline(time.Now().Add(wsIdleTimeout))
		typ, _ := msg["type"].(string)
		if authenticated {
			if !r.markDevicePresence(p) {
				return
			}
		}
		if typ == "ping" {
			p.sendJSON(map[string]any{"type": "pong", "timestamp": time.Now().UTC().Format(time.RFC3339Nano)})
			continue
		}
		if typ == "device-hello" {
			// A socket is bound to exactly one enrolled device. Accepting a second
			// hello would leave the old device ID pointing at this connection and
			// could route another user's proxy traffic to the wrong device.
			if authenticated {
				p.stop()
				return
			}
			deviceID, _ := msg["deviceId"].(string)
			deviceName, _ := msg["deviceName"].(string)
			deviceToken, _ := msg["deviceToken"].(string)
			if deviceToken == "" {
				deviceToken, _ = msg["deviceSecret"].(string)
			}
			var device deviceRecord
			var err error
			var issuedToken string
			if deviceToken != "" {
				storageCtx, cancelStorage := relayStorageContext()
				device, err = r.store.authenticateDevice(storageCtx, deviceID, deviceToken)
				cancelStorage()
			} else if legacy := msg["serverToken"]; legacy != nil && os.Getenv("CODEHARBOR_DEVICE_TOKEN") != "" && legacy == os.Getenv("CODEHARBOR_DEVICE_TOKEN") {
				storageCtx, cancelStorage := relayStorageContext()
				device, issuedToken, err = r.store.registerLegacyDevice(storageCtx, deviceID, deviceName)
				cancelStorage()
			} else {
				err = errDeviceUnauthorized
			}
			if err != nil || device.ID == "" {
				p.stop()
				return
			}
			p.deviceID = device.ID
			p.ownerUser = device.OwnerUser
			if deviceName == "" {
				deviceName = device.Name
			}
			// Redis-backed deployments use the presence key as a short-lived
			// device lease. This prevents two Relay instances from accepting the
			// same device concurrently and duplicating proxy requests.
			if previous := r.currentDevicePeer(p.deviceID); previous != nil && previous != p {
				previous.stop()
				r.clearDevicePresence(previous)
			}
			if !r.acquireDeviceLease(p) {
				p.stop()
				return
			}
			r.mu.Lock()
			previous := r.devices[p.deviceID]
			r.devices[p.deviceID] = p
			r.mu.Unlock()
			if previous != nil && previous != p {
				previous.stop()
			}
			response := map[string]any{"type": "device-ready", "deviceId": p.deviceID, "deviceName": deviceName}
			if issuedToken != "" {
				response["deviceToken"] = issuedToken
				response["deviceSecret"] = issuedToken
			}
			if device.OwnerUser == "" {
				storageCtx, cancelStorage := relayStorageContext()
				pair, pairErr := r.store.createPairCode(storageCtx, p.deviceID)
				cancelStorage()
				if pairErr == nil {
					response["pairCode"] = pair.Code
					response["pairCodeExpiresAt"] = pair.ExpiresAt
				}
			}
			p.sendJSON(response)
			authenticated = true
			_ = c.SetReadDeadline(time.Now().Add(wsIdleTimeout))
			if !r.markDevicePresence(p) {
				return
			}
			continue
		}
		if !authenticated {
			p.stop()
			return
		}
		if typ == "pair-code:create" {
			requestID, _ := msg["requestId"].(string)
			storageCtx, cancelStorage := relayStorageContext()
			pair, pairErr := r.store.createPairCode(storageCtx, p.deviceID)
			cancelStorage()
			if pairErr != nil {
				code := "pairing_failed"
				if errors.Is(pairErr, errPairCodeOwned) {
					code = "device_already_paired"
				} else if errors.Is(pairErr, errDeviceNotFound) {
					code = "device_not_found"
				}
				p.sendJSON(map[string]any{"type": "pair-code", "requestId": requestID, "error": code})
			} else {
				p.sendJSON(map[string]any{"type": "pair-code", "requestId": requestID, "pairCode": pair.Code, "pairCodeExpiresAt": pair.ExpiresAt})
			}
			continue
		}
		if typ == "session-sync" {
			storageCtx, cancelStorage := relayStorageContext()
			result, syncErr := r.handleSessionSync(storageCtx, p, msg)
			cancelStorage()
			log.Printf("session-sync device=%s owner=%s accepted=%d skipped=%d err=%v", p.deviceID, p.ownerUser, result.Accepted, result.Skipped, syncErr)
			response := map[string]any{
				"type":      "session-sync-ack",
				"requestId": msg["requestId"],
				"accepted":  result.Accepted,
				"skipped":   result.Skipped,
			}
			if syncErr != nil {
				response["accepted"] = 0
				response["skipped"] = 0
				if errors.Is(syncErr, errInvalidSessionSync) {
					response["error"] = "invalid_session_sync"
				} else if errors.Is(syncErr, errDeviceUnauthorized) {
					response["error"] = "unauthorized"
				} else {
					response["error"] = "storage_unavailable"
				}
			}
			p.sendJSON(response)
			continue
		}
		if typ == "gateway-event" {
			if payload, ok := msg["payload"].(map[string]any); ok {
				if id, ok := payload["sessionId"].(string); ok {
					storageCtx, cancelStorage := relayStorageContext()
					seq, err := r.store.appendOwnedEvent(storageCtx, id, p.ownerUser, payload)
					cancelStorage()
					if err != nil {
						p.sendJSON(map[string]any{"type": "gateway-event-error", "sessionId": id, "error": "session_not_owned"})
						continue
					}
					if seq > 0 {
						payload["eventSeq"] = seq
					}
				}
			}
			r.publishEvent(msg["payload"], p.deviceID)
			continue
		}
		if typ == "proxy-response" {
			id, _ := msg["requestId"].(string)
			r.mu.Lock()
			pending := r.pending[id]
			if pending != nil && pending.ownerUser == p.ownerUser && pending.deviceID == p.deviceID {
				delete(r.pending, id)
			} else {
				pending = nil
			}
			r.mu.Unlock()
			if pending != nil {
				if pending.timer != nil {
					pending.timer.Stop()
				}
				msg["type"] = "gateway-proxy-response"
				pending.browser.sendJSON(msg)
			} else if r.redis != nil {
				_ = r.publish(proxyResponsesChannel, map[string]any{"deviceId": p.deviceID, "requestId": id, "ownerUser": p.ownerUser, "payload": msg})
			}
		}
	}
}

func devicePresenceKey(deviceID string) string {
	return "codeharbor:device-presence:" + deviceID
}

func (r *relay) currentDevicePeer(deviceID string) *peer {
	if deviceID == "" {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.devices[deviceID]
}

func (r *relay) admitDevicePeer(p *peer) bool {
	if p == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.devicePeers == nil {
		r.devicePeers = make(map[*peer]struct{})
	}
	if len(r.devicePeers) >= maxDeviceConnectionsTotal {
		return false
	}
	if p.remoteIP != "" {
		perIP := 0
		for current := range r.devicePeers {
			if current.remoteIP == p.remoteIP {
				perIP++
			}
		}
		if perIP >= maxDeviceConnectionsPerIP {
			return false
		}
	}
	r.devicePeers[p] = struct{}{}
	return true
}

func (r *relay) acquireDeviceLease(p *peer) bool {
	if r.redis == nil || p.deviceID == "" || p.ownerUser == "" || p.presenceToken == "" {
		return true
	}
	ctx, cancel := redisOperationContext()
	defer cancel()
	ok, err := r.redis.SetNX(ctx, devicePresenceKey(p.deviceID), p.ownerUser+"|"+p.presenceToken, deviceLeaseTTL).Result()
	return err == nil && ok
}

// bindDeviceOwner atomically changes an unpaired device lease to its account
// owner. Pairing otherwise leaves the Redis value prefixed with an empty owner,
// causing the next heartbeat to consider the connection stale.
func (r *relay) bindDeviceOwner(p *peer, ownerUser string) bool {
	if p == nil || ownerUser == "" {
		return false
	}
	r.mu.RLock()
	oldOwner := p.ownerUser
	r.mu.RUnlock()
	if oldOwner != "" && oldOwner != ownerUser {
		return false
	}
	if r.redis != nil {
		const script = `local current = redis.call("GET", KEYS[1]); if not current or current == ARGV[1] or current == ARGV[2] then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 else return 0 end`
		ctx, cancel := redisOperationContext()
		result, err := r.redis.Eval(ctx, script, []string{devicePresenceKey(p.deviceID)}, oldOwner+"|"+p.presenceToken, ownerUser+"|"+p.presenceToken, int64(deviceLeaseTTL/time.Second)).Int()
		cancel()
		if err != nil || result != 1 {
			return false
		}
	}
	r.mu.Lock()
	p.ownerUser = ownerUser
	r.mu.Unlock()
	return true
}

func (r *relay) bindRemoteDeviceOwner(deviceID, ownerUser string) {
	r.mu.RLock()
	p := r.devices[deviceID]
	r.mu.RUnlock()
	if p == nil {
		return
	}
	if !r.bindDeviceOwner(p, ownerUser) {
		p.stop()
		return
	}
	p.sendJSON(map[string]any{"type": "device-owner-bound", "deviceId": deviceID, "ownerUser": ownerUser})
}

func (r *relay) deviceLeaseOwned(p *peer) bool {
	if p == nil || r.redis == nil {
		return p != nil
	}
	if p.deviceID == "" || p.ownerUser == "" || p.presenceToken == "" {
		return false
	}
	ctx, cancel := redisOperationContext()
	defer cancel()
	value, err := r.redis.Get(ctx, devicePresenceKey(p.deviceID)).Result()
	return err == nil && value == p.ownerUser+"|"+p.presenceToken
}

func (r *relay) markDevicePresence(p *peer) bool {
	if r.redis == nil || p.deviceID == "" || p.ownerUser == "" {
		return true
	}
	const script = `if redis.call("EXISTS", KEYS[2]) == 1 then return -1 elseif redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end`
	ctx, cancel := redisOperationContext()
	defer cancel()
	result, err := r.redis.Eval(ctx, script, []string{devicePresenceKey(p.deviceID), revokedDeviceKey(p.deviceID)}, p.ownerUser+"|"+p.presenceToken, int64(deviceLeaseTTL/time.Second)).Int()
	if err != nil || result == 0 {
		// The lease was lost or Redis is unavailable. Stop this connection so
		// callers cannot continue routing through an unowned device socket.
		p.stop()
		return false
	}
	return true
}

func (r *relay) clearDevicePresence(p *peer) {
	if r.redis == nil || p.deviceID == "" || p.ownerUser == "" || p.presenceToken == "" {
		return
	}
	const script = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`
	ctx, cancel := redisOperationContext()
	defer cancel()
	_, _ = r.redis.Eval(ctx, script, []string{devicePresenceKey(p.deviceID)}, p.ownerUser+"|"+p.presenceToken).Result()
}

func (r *relay) consumeEvents(ctx context.Context) {
	// Redis Pub/Sub channels close on a transient connection failure. Keep the
	// relay subscribed with bounded backoff so a brief Redis restart does not
	// silently disable cross-instance event delivery until the process restarts.
	backoff := time.Second
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		sub := r.redis.Subscribe(ctx, gatewayEventsChannel, proxyRequestsChannel, proxyResponsesChannel, authRevocationsChannel, deviceRevocationsChannel, deviceOwnershipChannel)
		if _, err := sub.Receive(ctx); err != nil {
			_ = sub.Close()
			if !sleepWithContext(ctx, backoff) {
				return
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		for message := range sub.Channel() {
			r.handleRedisMessage(message.Channel, message.Payload)
		}
		_ = sub.Close()
		if err := ctx.Err(); err != nil {
			return
		}
		if !sleepWithContext(ctx, backoff) {
			return
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func sleepWithContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func boundedHTTPContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if strings.HasPrefix(req.URL.Path, "/api/") || req.URL.Path == "/readyz" {
			ctx, cancel := context.WithTimeout(req.Context(), relayStorageOperationTimeout)
			defer cancel()
			req = req.WithContext(ctx)
		}
		next.ServeHTTP(w, req)
	})
}

func (r *relay) handleRedisMessage(channel, raw string) {
	// Revocation messages intentionally do not carry an owner user. Handle
	// them before the account-scoped envelope validation below; otherwise a
	// logout on one Relay instance is silently ignored by every other instance.
	if channel == authRevocationsChannel {
		var revocation struct {
			TokenHash string    `json:"tokenHash"`
			ExpiresAt time.Time `json:"expiresAt"`
		}
		if json.Unmarshal([]byte(raw), &revocation) == nil && revocation.TokenHash != "" && revocation.ExpiresAt.After(time.Now()) {
			rememberRevokedHash(revocation.TokenHash, revocation.ExpiresAt)
			r.disconnectBrowsersByTokenHash(revocation.TokenHash)
		}
		return
	}
	if channel == deviceOwnershipChannel {
		var ownership struct {
			DeviceID  string `json:"deviceId"`
			OwnerUser string `json:"ownerUser"`
		}
		if json.Unmarshal([]byte(raw), &ownership) == nil && ownership.DeviceID != "" && ownership.OwnerUser != "" {
			r.bindRemoteDeviceOwner(ownership.DeviceID, ownership.OwnerUser)
		}
		return
	}
	var envelope struct {
		DeviceID  string         `json:"deviceId"`
		OwnerUser string         `json:"ownerUser"`
		RequestID string         `json:"requestId"`
		Payload   map[string]any `json:"payload"`
	}
	if json.Unmarshal([]byte(raw), &envelope) != nil || envelope.OwnerUser == "" {
		return
	}
	switch channel {
	case deviceRevocationsChannel:
		r.disconnectOwnedDevice(envelope.DeviceID, envelope.OwnerUser)
	case gatewayEventsChannel:
		r.broadcast(envelope.Payload, envelope.DeviceID, envelope.OwnerUser)
	case proxyRequestsChannel:
		if envelope.Payload == nil {
			return
		}
		r.mu.RLock()
		device := r.devices[envelope.DeviceID]
		owned := device != nil && device.ownerUser == envelope.OwnerUser
		r.mu.RUnlock()
		if owned && !r.deviceLeaseOwned(device) {
			r.mu.Lock()
			if r.devices[envelope.DeviceID] == device {
				delete(r.devices, envelope.DeviceID)
			}
			r.mu.Unlock()
			device.stop()
			owned = false
		}
		if owned {
			device.sendJSON(envelope.Payload)
		}
	case proxyResponsesChannel:
		r.mu.Lock()
		pending := r.pending[envelope.RequestID]
		if pending != nil && pending.ownerUser == envelope.OwnerUser && pending.deviceID == envelope.DeviceID {
			delete(r.pending, envelope.RequestID)
		}
		r.mu.Unlock()
		if pending == nil || pending.ownerUser != envelope.OwnerUser || pending.deviceID != envelope.DeviceID {
			return
		}
		if pending.timer != nil {
			pending.timer.Stop()
		}
		envelope.Payload["type"] = "gateway-proxy-response"
		pending.browser.sendJSON(envelope.Payload)
	}
}

func (r *relay) disconnectBrowsersByTokenHash(tokenHash string) {
	if tokenHash == "" {
		return
	}
	r.mu.RLock()
	peers := make([]*peer, 0)
	for p := range r.browsers {
		if p.authTokenHash == tokenHash {
			peers = append(peers, p)
		}
	}
	r.mu.RUnlock()
	for _, p := range peers {
		p.stop()
	}
}

func (r *relay) broadcast(payload any, deviceID, ownerUser string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for p := range r.browsers {
		if ownerUser == "" || p.ownerUser != ownerUser {
			continue
		}
		if deviceID != "" && !p.subscriptions[deviceID] {
			continue
		}
		p.sendJSON(payload)
	}
}
func (r *relay) publishEvent(payload any, deviceID string) {
	r.mu.RLock()
	ownerUser := ""
	if device := r.devices[deviceID]; device != nil {
		ownerUser = device.ownerUser
	}
	r.mu.RUnlock()
	if r.redis == nil {
		r.broadcast(payload, deviceID, ownerUser)
		return
	}
	data, err := json.Marshal(map[string]any{"deviceId": deviceID, "ownerUser": ownerUser, "payload": payload})
	if err == nil {
		ctx, cancel := redisOperationContext()
		publishErr := r.redis.Publish(ctx, gatewayEventsChannel, data).Err()
		cancel()
		if publishErr != nil {
			// Preserve local real-time delivery during a Redis outage. Other relay
			// instances will recover missed events through the persisted cursor.
			r.broadcast(payload, deviceID, ownerUser)
		}
	}
}

func (r *relay) publish(channel string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	ctx, cancel := redisOperationContext()
	defer cancel()
	return r.redis.Publish(ctx, channel, data).Err()
}
func (r *relay) remove(p *peer) {
	r.clearDevicePresence(p)
	r.mu.Lock()
	delete(r.browsers, p)
	delete(r.devicePeers, p)
	deviceIsCurrent := p.deviceID != "" && r.devices[p.deviceID] == p
	if p.deviceID != "" {
		if current := r.devices[p.deviceID]; current == p {
			delete(r.devices, p.deviceID)
		}
	}
	for requestID, pending := range r.pending {
		if pending.browser == p || (deviceIsCurrent && pending.deviceID == p.deviceID) {
			if pending.timer != nil {
				pending.timer.Stop()
			}
			delete(r.pending, requestID)
			if pending.browser != p {
				pending.browser.sendJSON(map[string]any{"type": "gateway-proxy-response", "requestId": requestID, "status": http.StatusBadGateway, "error": "device_disconnected"})
			}
		}
	}
	r.mu.Unlock()
	p.stop()
}

func main() {
	if os.Getenv("NODE_ENV") == "production" {
		if err := validateProductionConfig(os.Getenv); err != nil {
			log.Fatal(err)
		}
	}
	ctx, stopSignal := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignal()
	persistence, err := newStore(ctx)
	if err != nil {
		log.Fatal(err)
	}
	var redisClient *redis.Client
	if raw := os.Getenv("REDIS_URL"); raw != "" {
		options, parseErr := redis.ParseURL(raw)
		if parseErr != nil {
			log.Fatal(parseErr)
		}
		redisClient = redis.NewClient(options)
		pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
		pingErr := redisClient.Ping(pingCtx).Err()
		cancelPing()
		if pingErr != nil {
			log.Fatal(pingErr)
		}
	} else if os.Getenv("NODE_ENV") == "production" {
		log.Fatal("REDIS_URL is required in production")
	}
	r := &relay{browsers: map[*peer]struct{}{}, devices: map[string]*peer{}, pending: map[string]*pendingProxy{}, store: persistence, redis: redisClient}
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := persistence.cleanupExpired(ctx); err != nil {
					log.Printf("expired record cleanup failed: %v", err)
				}
			}
		}
	}()
	if redisClient != nil {
		go r.consumeEvents(ctx)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", r.serveBrowser)
	mux.HandleFunc("/relay/device", r.serveDevice)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"codeharbor-relay-go"}`))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, req *http.Request) {
		storageCtx, cancelStorage := context.WithTimeout(req.Context(), relayStorageOperationTimeout)
		err := persistence.ready(storageCtx)
		cancelStorage()
		if err != nil {
			http.Error(w, `{"ready":false,"dependency":"postgres"}`, http.StatusServiceUnavailable)
			return
		}
		if redisClient != nil {
			redisCtx, cancelRedis := redisRequestContext(req.Context())
			err := redisClient.Ping(redisCtx).Err()
			cancelRedis()
			if err != nil {
				http.Error(w, `{"ready":false,"dependency":"redis"}`, http.StatusServiceUnavailable)
				return
			}
		} else if os.Getenv("NODE_ENV") == "production" {
			http.Error(w, `{"ready":false,"dependency":"redis"}`, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ready":true}`))
	})
	registerAPI(mux, r)
	srv := &http.Server{Addr: ":" + env("PORT", "8899"), Handler: boundedHTTPContext(mux), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 32 << 10}
	log.Printf("CodeHarbor Go relay listening on %s", srv.Addr)
	serverErr := make(chan error, 1)
	go func() { serverErr <- srv.ListenAndServe() }()
	select {
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("relay graceful shutdown failed: %v", err)
		}
		if redisClient != nil {
			_ = redisClient.Close()
		}
		if persistence.pool != nil {
			persistence.pool.Close()
		}
	}
}

func validateProductionConfig(getenv func(string) string) error {
	for _, requirement := range []struct {
		name string
		min  int
	}{
		{"CODEHARBOR_CLOUD_TOKEN", 32},
		{"CODEHARBOR_DEVICE_TOKEN", 32},
		{"CODEHARBOR_AUTH_SECRET", 32},
		{"CODEHARBOR_ADMIN_PASSWORD", 12},
	} {
		value := getenv(requirement.name)
		if strings.TrimSpace(value) == "" || len(value) < requirement.min {
			return fmt.Errorf("production requires %s with at least %d characters", requirement.name, requirement.min)
		}
	}
	if strings.TrimSpace(getenv("CODEHARBOR_ALLOWED_ORIGIN")) == "" {
		return errors.New("production requires CODEHARBOR_ALLOWED_ORIGIN")
	}
	return nil
}
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
