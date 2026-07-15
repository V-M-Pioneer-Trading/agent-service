package spacetraders

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"vnm/agent-info-service/spacetraders/schema"
)

const BASE_URL = "https://api.spacetraders.io/v2"

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

// makeAuthenticatedRequest forwards authHeader as-is to SpaceTraders (never stored),
// decodes a 2xx JSON body into T, and returns an *UpstreamError for non-2xx responses
// instead of panicking so callers (HTTP handlers) can map it to a proper status code.
func makeAuthenticatedRequest[T any](method, endpoint, authHeader string, body io.Reader) (T, error) {
	var result T

	req, err := http.NewRequest(method, BASE_URL+endpoint, body)
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", authHeader)
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
