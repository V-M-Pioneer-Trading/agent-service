package spacetraders

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"vnm/agent-info-service/spacetraders/schema"
)

const (
	// defaultGatewayURL is st-gateway's local-dev address.
	defaultGatewayURL = "http://localhost:3002"

	// requestTimeout bounds every upstream call. Without it a stuck gateway
	// pins the calling handler — and its connection — indefinitely.
	requestTimeout = 30 * time.Second

	// maxErrorBody caps how much of a failing response is read at all. Generous
	// next to maxMessageLength because a real envelope has to parse whole, and
	// small enough that a broken intermediary answering with a stream cannot be
	// bounded only by memory.
	maxErrorBody = 64 << 10

	// maxMessageLength caps the part of an unrecognised error body worth
	// relaying. An error message is read by a person; echoing a megabyte of
	// someone else's HTML through three service logs is not diagnosis.
	maxMessageLength = 500
)

// forwardedHeaders are the pacing signals st-gateway forwards on a passed-through
// 429, and that a caller needs in order to back off rather than hammer the shared
// budget.
var forwardedHeaders = []string{"Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"}

// Client talks to SpaceTraders through st-gateway's shared rate budget
// (meta#1/meta#7) rather than hitting SpaceTraders directly. It holds no game
// credential: st-gateway injects the agent token itself (auth-design.md
// decision 5). The only header it forwards is the caller's own Clerk session,
// verbatim, so st-gateway can derive queue priority from a verified identity
// (decision 2): a human session earns the interactive lane, a machine token or
// nothing at all queues as background. Nothing here is a caller's to spoof.
//
// One Client is meant to be built once and shared. Its http.Client pools
// connections to the gateway; building one per request would discard the pool
// and open a fresh socket every time.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient reads ST_GATEWAY_URL once at startup, falling back to the local-dev
// gateway address.
func NewClient() *Client {
	base := os.Getenv("ST_GATEWAY_URL")
	if base == "" {
		base = defaultGatewayURL
	}
	return NewClientWithBaseURL(base)
}

// NewClientWithBaseURL builds a Client against an explicit gateway address.
// Tests use it to point at a stub gateway without touching process env.
//
// A trailing slash on the configured URL is trimmed: "http://host:3002/" would
// otherwise produce "//proxy/...", which st-gateway's Express router treats as
// a different path and 404s. That is a plausible way to write the variable and
// a confusing way to fail.
func NewClientWithBaseURL(gatewayURL string) *Client {
	return &Client{
		baseURL: strings.TrimRight(gatewayURL, "/") + "/proxy",
		http:    &http.Client{Timeout: requestTimeout},
	}
}

// BaseURL is the fully-qualified proxy prefix every call is built on.
func (c *Client) BaseURL() string { return c.baseURL }

// ctxKey keeps this package's context values from colliding with anyone else's.
type ctxKey int

const callerAuthorizationKey ctxKey = iota

// WithCallerAuthorization records the inbound Authorization header (the
// caller's verified Clerk session) for forwarding on every upstream call made
// with the returned context. The api package sets it once, in middleware; no
// handler needs to know it exists.
func WithCallerAuthorization(ctx context.Context, authorizationHeader string) context.Context {
	return context.WithValue(ctx, callerAuthorizationKey, authorizationHeader)
}

func callerAuthorization(ctx context.Context) string {
	v, _ := ctx.Value(callerAuthorizationKey).(string)
	return v
}

func (c *Client) GetMyAgent(ctx context.Context) (schema.Agent, error) {
	resp, err := request[schema.GetMyAgentResponse](ctx, c, http.MethodGet, "/my/agent", nil)
	return resp.Data, err
}

func (c *Client) GetMyShips(ctx context.Context) ([]schema.Ship, error) {
	resp, err := request[schema.GetMyShipsResponse](ctx, c, http.MethodGet, "/my/ships", nil)
	return resp.Data, err
}

func (c *Client) GetMyShip(ctx context.Context, shipSymbol string) (schema.Ship, error) {
	resp, err := request[schema.GetMyShipResponse](ctx, c, http.MethodGet, "/my/ships/"+url.PathEscape(shipSymbol), nil)
	return resp.Data, err
}

func (c *Client) GetMyContracts(ctx context.Context) ([]schema.Contract, error) {
	resp, err := request[schema.GetMyContractsResponse](ctx, c, http.MethodGet, "/my/contracts", nil)
	return resp.Data, err
}

func (c *Client) GetMyContract(ctx context.Context, contractId string) (schema.Contract, error) {
	resp, err := request[schema.GetMyContractResponse](ctx, c, http.MethodGet, "/my/contracts/"+url.PathEscape(contractId), nil)
	return resp.Data, err
}

func (c *Client) AcceptContract(ctx context.Context, contractId string) (schema.ContractAndAgent, error) {
	resp, err := request[schema.AcceptContractResponse](ctx, c, http.MethodPost, "/my/contracts/"+url.PathEscape(contractId)+"/accept", nil)
	return resp.Data, err
}

func (c *Client) FulfillContract(ctx context.Context, contractId string) (schema.ContractAndAgent, error) {
	resp, err := request[schema.FulfillContractResponse](ctx, c, http.MethodPost, "/my/contracts/"+url.PathEscape(contractId)+"/fulfill", nil)
	return resp.Data, err
}

func (c *Client) PurchaseShip(ctx context.Context, shipType, waypointSymbol string) (schema.PurchaseShipResult, error) {
	body, err := jsonBody(map[string]string{"shipType": shipType, "waypointSymbol": waypointSymbol})
	if err != nil {
		return schema.PurchaseShipResult{}, err
	}
	resp, err := request[schema.PurchaseShipResponse](ctx, c, http.MethodPost, "/my/ships", body)
	return resp.Data, err
}

func (c *Client) PurchaseCargo(ctx context.Context, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	return c.tradeCargo(ctx, shipSymbol, "purchase", tradeSymbol, units)
}

func (c *Client) SellCargo(ctx context.Context, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	return c.tradeCargo(ctx, shipSymbol, "sell", tradeSymbol, units)
}

// tradeCargo is purchase-cargo and sell-cargo: identical request and response
// shapes, different trailing path segment.
func (c *Client) tradeCargo(ctx context.Context, shipSymbol, action, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	body, err := jsonBody(map[string]any{"symbol": tradeSymbol, "units": units})
	if err != nil {
		return schema.MarketTransactionResult{}, err
	}
	resp, err := request[schema.MarketTransactionResponse](ctx, c, http.MethodPost, "/my/ships/"+url.PathEscape(shipSymbol)+"/"+action, body)
	return resp.Data, err
}

// gatewayDidNotAnswer is the one verdict this service is entitled to reach on its
// own, because it is the only party that observed it: connection refused, DNS
// failure, timeout, or a body that died mid-read. 504 rather than 502 — the fault
// is upstream of the caller and a retry may work, where 502 here means "answered,
// and I cannot use it".
//
// The message names the gateway and stops there. The transport error carries the
// internal ST_GATEWAY_URL host and port, which is not a caller's business; it
// stays in the chain via Unwrap for logs and for errors.Is.
func gatewayDidNotAnswer(method, endpoint string, err error) error {
	return &UpstreamError{
		StatusCode: http.StatusGatewayTimeout,
		Message:    "st-gateway did not answer",
		Endpoint:   method + " " + endpoint,
		Err:        err,
	}
}

// upstreamMessage pulls the human-readable reason out of an error body.
//
// st-gateway and SpaceTraders both answer {"error":{"message"}}. Anything else —
// a proxy between here and the gateway answering with an HTML page — has no
// message to lift, so the raw body stands in, truncated.
func upstreamMessage(body []byte) string {
	var envelope struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && strings.TrimSpace(envelope.Error.Message) != "" {
		return envelope.Error.Message
	}
	text := string(body)
	if strings.TrimSpace(text) == "" {
		return "st-gateway returned an error with no message"
	}
	// Runes, not bytes: slicing bytes can split a multi-byte character and hand
	// the caller invalid UTF-8, and the contract counts characters.
	if runes := []rune(text); len(runes) > maxMessageLength {
		return string(runes[:maxMessageLength])
	}
	return text
}

func pacingHeaders(h http.Header) map[string]string {
	var pacing map[string]string
	for _, name := range forwardedHeaders {
		if value := h.Get(name); value != "" {
			if pacing == nil {
				pacing = make(map[string]string, len(forwardedHeaders))
			}
			pacing[name] = value
		}
	}
	return pacing
}

func jsonBody(v any) (io.Reader, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(raw), nil
}

// request sends one call through st-gateway, decodes a 2xx JSON body into T, and returns an *UpstreamError for non-2xx responses
// instead of panicking so handlers can map it to a proper status code.
func request[T any](ctx context.Context, c *Client, method, endpoint string, body io.Reader) (T, error) {
	var result T

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+endpoint, body)
	if err != nil {
		return result, err
	}
	if auth := callerAuthorization(ctx); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			// The caller hung up or its deadline passed. Not a gateway fault, and
			// nobody is left to read the answer — returning it as one would put a
			// gateway failure in the logs for every abandoned request.
			return result, fmt.Errorf("%s %s: %w", method, endpoint, ctxErr)
		}
		return result, gatewayDidNotAnswer(method, endpoint, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		// Bounded read: a misbehaving upstream shouldn't be able to grow an
		// error message without limit.
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return result, &UpstreamError{
			StatusCode: resp.StatusCode,
			Message:    upstreamMessage(respBody),
			Endpoint:   method + " " + endpoint,
			Headers:    pacingHeaders(resp.Header),
		}
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		// The body died mid-read. Same class as never connecting — the gateway's
		// answer never arrived — so the same verdict, per the contract.
		return result, gatewayDidNotAnswer(method, endpoint, err)
	}
	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &result); err != nil {
			return result, err
		}
	}
	return result, nil
}
