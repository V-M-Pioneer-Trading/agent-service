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

func GetMyAgent(authHeader string) (schema.Agent, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyAgentResponse](http.MethodGet, "/my/agent", authHeader, nil)
	return resp.Data, err
}

func GetMyShips(authHeader string) ([]schema.Ship, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyShipsResponse](http.MethodGet, "/my/ships", authHeader, nil)
	return resp.Data, err
}

func GetMyShip(authHeader, shipSymbol string) (schema.Ship, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyShipResponse](http.MethodGet, "/my/ships/"+shipSymbol, authHeader, nil)
	return resp.Data, err
}

func GetMyContracts(authHeader string) ([]schema.Contract, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyContractsResponse](http.MethodGet, "/my/contracts", authHeader, nil)
	return resp.Data, err
}

func GetMyContract(authHeader, contractId string) (schema.Contract, error) {
	resp, err := makeAuthenticatedRequest[schema.GetMyContractResponse](http.MethodGet, "/my/contracts/"+contractId, authHeader, nil)
	return resp.Data, err
}

func AcceptContract(authHeader, contractId string) (schema.ContractAndAgent, error) {
	resp, err := makeAuthenticatedRequest[schema.AcceptContractResponse](http.MethodPost, "/my/contracts/"+contractId+"/accept", authHeader, nil)
	return resp.Data, err
}

func FulfillContract(authHeader, contractId string) (schema.ContractAndAgent, error) {
	resp, err := makeAuthenticatedRequest[schema.FulfillContractResponse](http.MethodPost, "/my/contracts/"+contractId+"/fulfill", authHeader, nil)
	return resp.Data, err
}

// makeAuthenticatedRequest forwards authHeader as-is through st-gateway (never
// stored), decodes a 2xx JSON body into T, and returns an *UpstreamError for
// non-2xx responses instead of panicking so callers (HTTP handlers) can map it
// to a proper status code.
//
// Every call here is triggered by a browser request to agent-service today —
// there is no background caller yet (that lands with automation-service's ship
// FSMs) — so all traffic is tagged interactive. Once automation-service calls
// agent-service directly, this needs to forward whatever priority the caller
// declared instead of hardcoding it.
func makeAuthenticatedRequest[T any](method, endpoint, authHeader string, body io.Reader) (T, error) {
	var result T

	req, err := http.NewRequest(method, gatewayBaseURL()+endpoint, body)
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("X-Priority", "interactive")
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
