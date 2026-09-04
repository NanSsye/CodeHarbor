package main

import (
	"encoding/json"
	"time"

	"github.com/gorilla/websocket"
)

func (p *peer) writeLoop() {
	for {
		select {
		case <-p.closed:
			return
		case payload := <-p.outbound:
			if payload == nil {
				return
			}
			p.outboundBytes.Add(-int64(len(payload)))
			if err := p.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout)); err != nil {
				p.stop()
				return
			}
			if err := p.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				p.stop()
				return
			}
		}
	}
}

func (p *peer) sendJSON(value any) bool {
	payload, err := json.Marshal(value)
	if err != nil {
		return false
	}
	if len(payload) > maxPeerOutboundBytes || !p.reserveOutboundBytes(int64(len(payload))) {
		p.stop()
		return false
	}
	select {
	case <-p.closed:
		p.outboundBytes.Add(-int64(len(payload)))
		return false
	case p.outbound <- payload:
		return true
	default:
		p.outboundBytes.Add(-int64(len(payload)))
		p.stop()
		return false
	}
}

// sendJSONBlocking is used only for bounded resume replays. A replay can
// legitimately contain thousands of small events; treating the first full
// queue as a slow-consumer violation would disconnect an otherwise healthy
// browser before its reader has a chance to drain the socket. Keep the wait
// bounded so a genuinely stalled client still gets closed.
func (p *peer) sendJSONBlocking(value any, timeout time.Duration) bool {
	return p.sendJSONBlockingUntil(value, time.Now().Add(timeout))
}

func (p *peer) sendJSONBlockingUntil(value any, deadline time.Time) bool {
	payload, err := json.Marshal(value)
	if err != nil || len(payload) > maxPeerOutboundBytes {
		return false
	}
	for {
		select {
		case <-p.closed:
			return false
		default:
		}
		if !p.reserveOutboundBytes(int64(len(payload))) {
			if time.Now().After(deadline) {
				p.stop()
				return false
			}
			time.Sleep(2 * time.Millisecond)
			continue
		}
		select {
		case <-p.closed:
			p.outboundBytes.Add(-int64(len(payload)))
			return false
		case p.outbound <- payload:
			return true
		default:
			p.outboundBytes.Add(-int64(len(payload)))
			if time.Now().After(deadline) {
				p.stop()
				return false
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
}

func (p *peer) reserveOutboundBytes(size int64) bool {
	for {
		current := p.outboundBytes.Load()
		if size <= 0 || size > maxPeerOutboundBytes || current > maxPeerOutboundBytes-size {
			return false
		}
		if p.outboundBytes.CompareAndSwap(current, current+size) {
			return true
		}
	}
}
