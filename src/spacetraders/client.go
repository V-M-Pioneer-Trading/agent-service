package spacetraders

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"vnm/agent-info-service/spacetraders/schema"
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
// credential of its own and needs none: st-gateway injects the SpaceTraders
// token itself, from auth-service (auth-design.md decision 5).
//
// What every method takes instead is callerAuth — the Clerk Authorization
// header of whoever called this service, already verified by the api package.
// st-gateway does not authenticate with it; it derives the request's priority
// class from it (decision 2), so a browser session keeps the interactive lane
// across this hop and a machine caller stays on background. Forwarding an
// empty string is safe and simply means background.
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
func NewClientWithBaseURL(gatewayURL string) *Client {
	return &Client{
		baseURL: gatewayURL + "/proxy",
		http:    &http.Client{Timeout: requestTimeout},
	}
}

// BaseURL is the fully-qualified proxy prefix every call is built on.
func (c *Client) BaseURL() string { return c.baseURL }

func (c *Client) GetMyAgent(callerAuth string) (schema.Agent, error) {
	resp, err := request[schema.GetMyAgentResponse](c, http.MethodGet, "/my/agent", callerAuth, nil)
	return resp.Data, err
}

func (c *Client) GetMyShips(callerAuth string) ([]schema.Ship, error) {
	resp, err := request[schema.GetMyShipsResponse](c, http.MethodGet, "/my/ships", callerAuth, nil)
	return resp.Data, err
}

func (c *Client) GetMyShip(callerAuth, shipSymbol string) (schema.Ship, error) {
	resp, err := request[schema.GetMyShipResponse](c, http.MethodGet, "/my/ships/"+shipSymbol, callerAuth, nil)
	return resp.Data, err
}

func (c *Client) GetMyContracts(callerAuth string) ([]schema.Contract, error) {
	resp, err := request[schema.GetMyContractsResponse](c, http.MethodGet, "/my/contracts", callerAuth, nil)
	return resp.Data, err
}

func (c *Client) GetMyContract(callerAuth, contractId string) (schema.Contract, error) {
	resp, err := request[schema.GetMyContractResponse](c, http.MethodGet, "/my/contracts/"+contractId, callerAuth, nil)
	return resp.Data, err
}

func (c *Client) AcceptContract(callerAuth, contractId string) (schema.ContractAndAgent, error) {
	resp, err := request[schema.AcceptContractResponse](c, http.MethodPost, "/my/contracts/"+contractId+"/accept", callerAuth, nil)
	return resp.Data, err
}

func (c *Client) FulfillContract(callerAuth, contractId string) (schema.ContractAndAgent, error) {
	resp, err := request[schema.FulfillContractResponse](c, http.MethodPost, "/my/contracts/"+contractId+"/fulfill", callerAuth, nil)
	return resp.Data, err
}

func (c *Client) PurchaseShip(callerAuth, shipType, waypointSymbol string) (schema.PurchaseShipResult, error) {
	body, err := jsonBody(map[string]string{"shipType": shipType, "waypointSymbol": waypointSymbol})
	if err != nil {
		return schema.PurchaseShipResult{}, err
	}
	resp, err := request[schema.PurchaseShipResponse](c, http.MethodPost, "/my/ships", callerAuth, body)
	return resp.Data, err
}

func (c *Client) PurchaseCargo(callerAuth, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	return c.tradeCargo(callerAuth, shipSymbol, "purchase", tradeSymbol, units)
}

func (c *Client) SellCargo(callerAuth, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	return c.tradeCargo(callerAuth, shipSymbol, "sell", tradeSymbol, units)
}

// tradeCargo is purchase-cargo and sell-cargo: identical request and response
// shapes, different trailing path segment.
func (c *Client) tradeCargo(callerAuth, shipSymbol, action, tradeSymbol string, units int) (schema.MarketTransactionResult, error) {
	body, err := jsonBody(map[string]any{"symbol": tradeSymbol, "units": units})
	if err != nil {
		return schema.MarketTransactionResult{}, err
	}
	resp, err := request[schema.MarketTransactionResponse](c, http.MethodPost, "/my/ships/"+shipSymbol+"/"+action, callerAuth, body)
	return resp.Data, err
}

func jsonBody(v any) (io.Reader, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(raw), nil
}

// request forwards authHeader as-is through st-gateway (never stored), decodes
// a 2xx JSON body into T, and returns an *UpstreamError for non-2xx responses
// instead of panicking so handlers can map it to a proper status code.
func request[T any](c *Client, method, endpoint, callerAuth string, body io.Reader) (T, error) {
	var result T

	req, err := http.NewRequest(method, c.baseURL+endpoint, body)
	if err != nil {
		return result, err
	}
	if callerAuth != "" {
		req.Header.Set("Authorization", callerAuth)
	}
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
