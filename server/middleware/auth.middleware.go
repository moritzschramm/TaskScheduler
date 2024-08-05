package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

// checks if the current session is authenticated
func AuthMiddleware() func(*fiber.Ctx) error {

	return func(c *fiber.Ctx) error {

		session, ok := c.Locals(SessionKey).(*session.Session)
		if !ok {
			return SessionError
		}

		// check if session has user key (only set after login, removed after logout)
		for _, key := range session.Keys() {
			if key == UserKey {
				return c.Next()
			}
		}

		return c.SendStatus(fiber.StatusUnauthorized)
	}
}
