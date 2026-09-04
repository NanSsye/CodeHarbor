FROM golang:1.26.7-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o /out/codeharbor-relay .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/codeharbor-relay /codeharbor-relay
# The relay only binds an unprivileged port and does not need filesystem write
# access. Keep the runtime on distroless' nonroot UID for production isolation.
USER nonroot
EXPOSE 8899
ENTRYPOINT ["/codeharbor-relay"]
