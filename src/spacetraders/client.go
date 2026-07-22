package spacetraders

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"vnm/agent-info-service/spacetraders/schema"
)

// All SpaceTraders calls route through st-gateway's shared rate budget
// (meta#1/meta#7) instead of hitting SpaceTraders directly.
func gatewayBaseURL() string {
	if v := os.Getenv("ST_GATEWAY_URL"); v != "" {
		return v + "/proxy"
	}
	return "http://localhost:3002/proxy"
}

func GetMyAgent(authHeader, priority string) (schema.Agent, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyAgentResponse](http.MethodGet, "/my/agent", authHeader, priority, nil)
	return resp.Data, err
}

func GetMyShips(authHeader, priority string) ([]schema.Ship, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyShipsResponse](http.MethodGet, "/my/ships", authHeader, priority, nil)
	return resp.Data, err
}

func GetMyShip(authHeader, priority, shipSymbol string) (schema.Ship, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyShipResponse](http.MethodGet, "/my/ships/"+shipSymbol, authHeader, priority, nil)
	return resp.Data, err
}

func GetMyContracts(authHeader, priority string) ([]schema.Contract, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyContractsResponse](http.MethodGet, "/my/contracts", authHeader, priority, nil)
	return resp.Data, err
}

func GetMyContract(authHeader, priority, contractId string) (schema.Contract, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyContractResponse](http.MethodGet, "/my/contracts/"+contractId, authHeader, priority, nil)
	return resp.Data, err
}

func AcceptContract(authHeader, priority, contractId string) (schema.ContractAndAgent, error) {
	resp, err := makeAuthenticatedRequest[schema.AcceptContractResponse](http.MethodPost, "/my/contracts/"+contractId+"/accept", authHeader, priority, nil)
	return resp.Data, err
}

func FulfillContract(authHeader, priority, contractId string) (schema.ContractAndAgent, error) {
	resp, err := makeAuthenticatedRequest[schema.FulfillContractResponse](http.MethodPost, "/my/contracts/"+contractId+"/fulfill", authHeader, priority, nil)
	return resp.Data, err
}

// makeAuthenticatedRequest forwards authHeader as-is through st-gateway (never
// stored), decodes a 2xx JSON body into T, and returns an *UpstreamError for
// non-2xx responses instead of panicking so callers (HTTP handlers) can map it
// to a proper status code.
//
// priority forwards the caller's own X-Priority declaration through to
// st-gateway's priority queue (meta#37) — command-interface (browser) sends
// "interactive", automation-service (autopilot) sends nothing, and anything
// that isn't exactly "interactive" degrades to "background" so a missing or
// malformed header never accidentally jumps the queue.
func makeAuthenticatedRequest[T any](method, endpoint, authHeader, priority string, body io.Reader) (T, error) {
	var result T

	req, err := http.NewRequest(method, gatewayBaseURL()+endpoint, body)
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", authHeader)
	if priority == "interactive" {
		req.Header.Set("X-Priority", "interactive")
	} else {
		req.Header.Set("X-Priority", "background")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return result, err
	}

	if resp.StatusCode >= 400 {
		return result, &UpstreamError{
			StatusCode: resp.StatusCode,
			Message:    fmt.Sprintf("%s %s: %s", method, endpoint, string(respBody)),
		}
	}

	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &result); err != nil {
			return result, err
		}
	}

	return result, nil
}
