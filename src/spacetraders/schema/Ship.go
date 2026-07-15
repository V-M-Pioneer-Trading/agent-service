package schema

import "time"

// Ship represents the JSON structure for a ship
// https://spacetraders.stoplight.io/docs/spacetraders/78355ec106f61-ship
type Ship struct {
	Symbol       string       `json:"symbol"`
	Registration Registration `json:"registration"`
	Nav          Nav          `json:"nav"`
	Crew         Crew         `json:"crew"`
	Frame        Frame        `json:"frame"`
	Reactor      Reactor      `json:"reactor"`
	Engine       Engine       `json:"engine"`
	Cooldown     Cooldown     `json:"cooldown"`
	Modules      []Module     `json:"modules"`
	Mounts       []Mount      `json:"mounts"`
	Cargo        Cargo        `json:"cargo"`
	Fuel         Fuel         `json:"fuel"`
}

// Requirements represents common requirements for various components
// https://spacetraders.stoplight.io/docs/spacetraders/d8ab4201f957e-ship-requirements
type Requirements struct {
	Power int `json:"power"`
	Crew  int `json:"crew"`
	Slots int `json:"slots"`
}

// Represents a ship's module
// https://spacetraders.stoplight.io/docs/spacetraders/56a982a62bbd0-ship-module
type Module struct {
	Symbol       string       `json:"symbol"`
	Capacity     int          `json:"capacity"` // Modules that provide capacity, such as cargo hold or crew quarters will show this value to denote how much of a bonus the module grants.
	Range        int          `json:"range"`    // Modules that have a range will such as a sensor array show this value to denote how far can the module reach with its capabilities.
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	Requirements Requirements `json:"requirements"`
}

// Mount represents a ship's mount
// https://spacetraders.stoplight.io/docs/spacetraders/2b930d4d429b9-ship-mount
type Mount struct {
	Symbol       string       `json:"symbol"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	Strength     int          `json:"strength"` // Mounts that have this value, such as mining lasers, denote how powerful this mount's capabilities are.
	Deposits     []string     `json:"deposits"` // Mounts that have this value denote what goods can be produced from using the mount.
	Requirements Requirements `json:"requirements"`
}

// Cooldown represents the cooldown information for a ship
// https://spacetraders.stoplight.io/docs/spacetraders/af69da1976c46-cooldown
type Cooldown struct {
	ShipSymbol       string    `json:"shipSymbol"`
	TotalSeconds     int       `json:"totalSeconds"`
	RemainingSeconds int       `json:"remainingSeconds"`
	Expiration       time.Time `json:"expiration"`
}

// Fuel represents the fuel information for a ship
// https://spacetraders.stoplight.io/docs/spacetraders/02c894c5c9a42-ship-fuel
type Fuel struct {
	Current  int `json:"current"`
	Capacity int `json:"capacity"`
	Consumed struct {
		Amount    int       `json:"amount"`
		Timestamp time.Time `json:"timestamp"`
	} `json:"consumed"`
}

// Ship cargo details
// https://spacetraders.stoplight.io/docs/spacetraders/102fa7b24e117-ship-cargo
type Cargo struct {
	Capacity  int         `json:"capacity"`
	Units     int         `json:"units"`
	Inventory []CargoItem `json:"inventory"`
}

// The type of cargo item and the number of units.
// https://spacetraders.stoplight.io/docs/spacetraders/97be02b18f964-ship-cargo-item
type CargoItem struct {
	Symbol      string `json:"symbol"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Units       int    `json:"units"`
}

// Engine represents the engine information for a ship
// https://spacetraders.stoplight.io/docs/spacetraders/ee8ec9d35ba62-ship-engine
type Engine struct {
	Symbol       string       `json:"symbol"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	Condition    int          `json:"condition"`
	Integrity    int          `json:"integrity"`
	Speed        int          `json:"speed"`
	Requirements Requirements `json:"requirements"`
}

// Reactor represents the reactor information for a ship
// https://spacetraders.stoplight.io/docs/spacetraders/94ca0d23b92a9-ship-reactor
type Reactor struct {
	Symbol       string       `json:"symbol"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	Condition    int          `json:"condition"`
	Integrity    int          `json:"integrity"`
	PowerOutput  int          `json:"powerOutput"`
	Requirements Requirements `json:"requirements"`
}

// Frame represents the frame information for a ship
// https://spacetraders.stoplight.io/docs/spacetraders/ad5c4ec400bcd-ship-frame
type Frame struct {
	Symbol         string       `json:"symbol"`
	Name           string       `json:"name"`
	Description    string       `json:"description"`
	Condition      int          `json:"condition"`
	Integrity      int          `json:"integrity"`
	ModuleSlots    int          `json:"moduleSlots"`
	MountingPoints int          `json:"mountingPoints"`
	FuelCapacity   int          `json:"fuelCapacity"`
	Requirements   Requirements `json:"requirements"`
}

// The ship's crew service and maintain the ship's systems and equipment.
// https://spacetraders.stoplight.io/docs/spacetraders/fedd01af45057-ship-crew
type Crew struct {
	Current  int    `json:"current"`
	Required int    `json:"required"`
	Capacity int    `json:"capacity"`
	Rotation string `json:"rotation"`
	Morale   int    `json:"morale"`
	Wages    int    `json:"wages"`
}

// Route represents the route information for a ship's navigation
// https://spacetraders.stoplight.io/docs/spacetraders/73d4c05eed666-ship-nav-route
type Route struct {
	Destination   RouteWaypoint `json:"destination"`
	Origin        RouteWaypoint `json:"origin"`
	DepartureTime time.Time     `json:"departureTime"`
	Arrival       time.Time     `json:"arrival"`
}

// The destination or departure of a ships nav route.
// https://spacetraders.stoplight.io/docs/spacetraders/fa09a853a7974-ship-nav-route-waypoint
type RouteWaypoint struct {
	Symbol       string `json:"symbol"`
	Type         string `json:"type"`
	SystemSymbol string `json:"systemSymbol"`
	X            int    `json:"x"`
	Y            int    `json:"y"`
}

// Nav represents the navigation information for a ship
//
// Flight mode enum -> https://spacetraders.stoplight.io/docs/spacetraders/daeaae7d2b4fe-ship-nav-flight-mode
// Status Enum -> https://spacetraders.stoplight.io/docs/spacetraders/7f8d15160bdf4-ship-nav-status
type Nav struct {
	SystemSymbol      string `json:"systemSymbol"`
	WaypointSymbol    string `json:"waypointSymbol"`
	Route             Route  `json:"route"`
	ShipNavStatus     string `json:"status"`
	ShipNavFlightMode string `json:"flightMode"`
}

// Registration represents the registration information for a ship
// https://spacetraders.stoplight.io/docs/spacetraders/337bde58272c6-ship-registration
type Registration struct {
	Name          string `json:"name"`
	FactionSymbol string `json:"factionSymbol"`
	Role          string `json:"role"`
}

type PaginationMeta struct {
	Total int `json:"total"`
	Page  int `json:"page"`
	Limit int `json:"limit"`
}

type GetMyShipsResponse struct {
	Data []Ship         `json:"data"`
	Meta PaginationMeta `json:"meta"`
}

type GetMyShipResponse struct {
	Data Ship `json:"data"`
}
