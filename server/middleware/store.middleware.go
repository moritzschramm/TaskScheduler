package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

const StoreKey = "StoreMiddleware"

// injects KV store into context
// available via c.Locals(middleware.StoreKey)
func StoreMiddleware(store *session.Store) func(*fiber.Ctx) error {

	return func(c *fiber.Ctx) error {

		c.Locals(StoreKey, store)

		return c.Next()
	}
}
