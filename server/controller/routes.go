package controller

import (
	"task-scheduler/infrastructure"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

func SetupRoutes(api fiber.Router,
	db infrastructure.Database,
	store infrastructure.Store,
	session *session.Store) {

	cc := createControllers(db, store, session)

	api.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API version 0.1")
	})

	auth := api.Group("/auth")
	auth.Post("/login", cc.authController.Login)
	auth.Post("/register-email", cc.authController.RegisterEmail)
	auth.Post("/register-user-data", cc.authController.RegisterUser)
	auth.Post("/verify-email", cc.authController.VerifyEmailAndCreateUser)
}
