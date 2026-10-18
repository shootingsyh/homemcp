# tunneld — multi-stage build. The tunneld binary is pure Go stdlib
# (no cgo), so the final image is distroless/static with nothing in it
# but the binary. The control plane stores only metadata; it never
# touches user tunnel traffic (see ../README.md).
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/tunneld .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/tunneld /tunneld
# Informational only: compose does NOT publish this port. frps reaches it
# over the compose network; the public API/webhook ingress is a separate
# operator proxy (see ../README.md "Deploy outline").
EXPOSE 7200
USER nonroot:nonroot
ENTRYPOINT ["/tunneld"]
