package api

import (
	"encoding/json"

	swagv1 "github.com/swaggo/swag"

	"vnm/agent-info-service/docs"
)

// The generated docs package registers the spec with swag v2's registry, but
// http-swagger (v2.0.2, the latest) still reads swag v1's, so doc.json would
// answer 500 (swaggo/swag#1588). Registering the same spec with v1 bridges the
// two; drop this once http-swagger reads swag/v2. In init, not SetUpRouter:
// Register panics on a second call, and tests build many routers.
func init() {
	swagv1.Register(docs.SwaggerInfo.InstanceName(), servedSpec{docs.SwaggerInfo})
}

// servedSpec drops the root "schemes" key that swag v2.0.0-rc6 writes into
// docs.go's template even with --v3.1 (swaggo/swag#2194). It is a Swagger 2.0
// field, rendered here as null, and makes the served doc invalid OpenAPI 3.1;
// the committed swagger.json and swagger.yaml never contain it.
type servedSpec struct{ spec swagv1.Swagger }

func (s servedSpec) ReadDoc() string {
	doc := s.spec.ReadDoc()
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(doc), &root); err != nil {
		return doc
	}
	if _, ok := root["schemes"]; !ok {
		return doc
	}
	delete(root, "schemes")
	out, err := json.MarshalIndent(root, "", "    ")
	if err != nil {
		return doc
	}
	return string(out)
}
