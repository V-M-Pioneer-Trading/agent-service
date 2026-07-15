package schema

import "time"

// Contract details
// https://spacetraders.stoplight.io/docs/spacetraders/85b21d6187fa8-contract
type Contract struct {
	ID               string        `json:"id"`
	FactionSymbol    string        `json:"factionSymbol"`
	Type             string        `json:"type"`
	Terms            ContractTerms `json:"terms"`
	Accepted         bool          `json:"accepted"`
	Fulfilled        bool          `json:"fulfilled"`
	Expiration       time.Time     `json:"expiration"`
	DeadlineToAccept time.Time     `json:"deadlineToAccept"`
}

// https://spacetraders.stoplight.io/docs/spacetraders/23be8662e3dbe-contract-payment
type Payment struct {
	OnAccepted  int `json:"onAccepted"`
	OnFulfilled int `json:"onFulfilled"`
}

// The details of a delivery contract. Includes the type of good, units needed, and the destination.
// https://spacetraders.stoplight.io/docs/spacetraders/0622e70f079d8-contract-deliver-good
type DeliveryInfo struct {
	TradeSymbol       string `json:"tradeSymbol"`
	DestinationSymbol string `json:"destinationSymbol"`
	UnitsRequired     int    `json:"unitsRequired"`
	UnitsFulfilled    int    `json:"unitsFulfilled"`
}

// Terms to fulfill the contract
// https://spacetraders.stoplight.io/docs/spacetraders/c160410b5f20e-contract-terms
type ContractTerms struct {
	Deadline time.Time      `json:"deadline"`
	Payment  Payment        `json:"payment"`
	Deliver  []DeliveryInfo `json:"deliver"`
}

type GetMyContractsResponse struct {
	Data []Contract     `json:"data"`
	Meta PaginationMeta `json:"meta"`
}

type GetMyContractResponse struct {
	Data Contract `json:"data"`
}

// ContractAndAgent is the shared response shape of accept-contract and fulfill-contract.
type ContractAndAgent struct {
	Agent    Agent    `json:"agent"`
	Contract Contract `json:"contract"`
}

type AcceptContractResponse struct {
	Data ContractAndAgent `json:"data"`
}

type FulfillContractResponse struct {
	Data ContractAndAgent `json:"data"`
}
