package main

import (
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

func AuthMiddleware(store *session.Store) func(*fiber.Ctx) error {

	return func(c *fiber.Ctx) error {

		// get session from session store
		session, err := store.Get(c)
		if err != nil {
			return err
		}

		// check if session has user key (only set after login, removed after logout)
		for _, key := range session.Keys() {
			if key == "user" {
				return c.Next()
			}
		}

		return c.SendStatus(fiber.StatusUnauthorized)
	}
}
