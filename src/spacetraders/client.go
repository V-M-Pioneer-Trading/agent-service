package spacetraders

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"vnm/agent-info-service/spacetraders/schema"
)

// Priority values st-gateway's queue understands. Anything a caller declares
// that isn't exactly PriorityInteractive degrades to PriorityBackground, so a
// missing or malformed X-Priority never jumps the queue meant to keep the
// browser UI responsive (meta#37).
const (
	PriorityInteractive = "interactive"
	PriorityBackground  = "background"
)

const (
	// defaultGatewayURL is st-gateway's local-dev address.
	defaultGatewayURL = "http://localhost:3002"

	// requestTimeout bounds every upstream call. Without it a stuck gateway
	// pins the calling handler — and its connection — indefinitely.
	requestTimeout = 30 * time.Second

	// maxErrorBody caps how much of a failing response we read back into an
	// UpstreamError message.
	maxErrorBody = 64 << 10
)

// Client talks to SpaceTraders through st-gateway's shared rate budget
// (meta#1/meta#7) rather than hitting SpaceTraders directly. It holds no
// credential of its own: callers pass the game token per request and it is
// forwarded verbatim, never stored.
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

func (c *Client) GetMyAgent(authHeader, priority string) (schema.Agent, error) {
	resp, err := request[schema.GetMyAgentResponse](c, http.MethodGet, "/my/agent", authHeader, priority, nil)
	return resp.Data, err
}

func (c *Client) GetMyShips(authHeader, priority string) ([]schema.Ship, error) {
	resp, err := request[schema.GetMyShipsResponse](c, http.MethodGet, "/my/ships", authHeader, priority, nil)
	return resp.Data, err
}

func (c *Client) GetMyShip(authHeader, priority, shipSymbol string) (schema.Ship, error) {
	resp, err := request[schema.GetMyShipResponse](c, http.MethodGet, "/my/ships/"+shipSymbol, authHeader, priority, nil)
	return resp.Data, err
}

func (c *Client) GetMyContracts(authHeader, priority string) ([]schema.Contract, error) {
	resp, err := request[schema.GetMyContractsResponse](c, http.MethodGet, "/my/contracts", authHeader, priority, nil)
	return resp.Data, err
}

func (c *Client) GetMyContract(authHeader, priority, contractId string) (schema.Contract, error) {
	resp, err := request[schema.GetMyContractResponse](c, http.MethodGet, "/my/contracts/"+contractId, authHeader, priority, nil)
	return resp.Data, err
}

func (c *Client) AcceptContract(authHeader, priority, contractId string) (schema.ContractAndAgent, error) {
	resp, err := request[schema.AcceptContractResponse](c, http.MethodPost, "/my/contracts/"+contractId+"/accept", authHeader, priority, nil)
	return resp.Data, err
}

func (c *Client) FulfillContract(authHeader, priority, contractId string) (schema.ContractAndAgent, error) {
	resp, err := request[schema.FulfillContractResponse](c, http.MethodPost, "/my/contracts/"+contractId+"/fulfill", authHeader, priority, nil)
	return resp.Data, err
}

func (c *Client) PurchaseShip(authHeader, priority, shipType, waypointSymbol string) (schema.PurchaseShipResult, error) {
	body, err := jsonBody(map[string]string{"shipType": shipType, "waypointSymbol": waypointSymbol})
	if err != nil {
		return schema.PurchaseShipResult{}, err
	}
	resp, err := request[schema.PurchaseShipResponse](c, http.MethodPost, "/my/ships", authHeader, priority, body)
	return resp.Data, err
}

func (c *Client) PurchaseCargo(authHeader, priority, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	return c.tradeCargo(authHeader, priority, shipSymbol, "purchase", tradeSymbol, units)
}

func (c *Client) SellCargo(authHeader, priority, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	return c.tradeCargo(authHeader, priority, shipSymbol, "sell", tradeSymbol, units)
}

// tradeCargo is purchase-cargo and sell-cargo: identical request and response
// shapes, different trailing path segment.
func (c *Client) tradeCargo(authHeader, priority, shipSymbol, action, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	body, err := jsonBody(map[string]any{"symbol": tradeSymbol, "units": units})
	if err != nil {
		return schema.MarketTransactionResult{}, err
	}
	resp, err := request[schema.MarketTransactionResponse](c, http.MethodPost, "/my/ships/"+shipSymbol+"/"+action, authHeader, priority, body)
	return resp.Data, err
}

func jsonBody(v any) (io.Reader, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(raw), nil
}

// normalizePriority collapses a caller-declared priority to the only two values
// st-gateway acts on. See the Priority constants above.
func normalizePriority(priority string) string {
	if priority == PriorityInteractive {
		return PriorityInteractive
	}
	return PriorityBackground
}

// request forwards authHeader as-is through st-gateway (never stored), decodes
// a 2xx JSON body into T, and returns an *UpstreamError for non-2xx responses
// instead of panicking so handlers can map it to a proper status code.
func request[T any](c *Client, method, endpoint, authHeader, priority string, body io.Reader) (T, error) {
	var result T

	req, err := http.NewRequest(method, c.baseURL+endpoint, body)
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("X-Priority", normalizePriority(priority))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		// Bounded read: a misbehaving upstream shouldn't be able to grow an
		// error message without limit.
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return result, &UpstreamError{
			StatusCode: resp.StatusCode,
			Message:    fmt.Sprintf("%s %s: %s", method, endpoint, string(respBody)),
		}
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return result, err
	}
	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &result); err != nil {
			return result, err
		}
	}
	return result, nil
}
