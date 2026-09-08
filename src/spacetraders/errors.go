package spacetraders

import "fmt"

// UpstreamError is st-gateway's verdict on one call, carried back to the handler
// that has to answer for it.
//
// StatusCode and Message are the gateway's own wherever the gateway answered at
// all: it is the only party that talked to SpaceTraders and the only one that can
// see whether a credential exists, so re-deciding either here would be a guess
// overwriting a fact. This service classifies exactly one condition itself — "the
// gateway did not answer me", which is 504 — and keeps 502 for the narrow case of
// a 2xx it cannot read. See meta/docs/design/upstream-errors.md.
type UpstreamError struct {
	StatusCode int

	// Message is the upstream's own sentence, unaltered — its error.message where
	// there is an envelope, the raw body truncated where there is not. Handlers
	// write it straight out, so matching on it downstream has to mean the same
	// thing whichever service relayed it. That is why the endpoint lives in a
	// separate field rather than being prefixed onto it.
	Message string

	// Endpoint is for the log line, not for the caller.
	Endpoint string

	// Headers are the pacing signals st-gateway forwards on a passed-through 429
	// (Retry-After, X-RateLimit-*). Relaying the status without them keeps the
	// news and drops the instructions.
	Headers map[string]string
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("spacetraders upstream error (%d) on %s: %s", e.StatusCode, e.Endpoint, e.Message)
}
