package controller

import (
	"task-scheduler/infrastructure"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

func SetupRoutes(api fiber.Router,
	db infrastructure.Database,
	session *session.Store) {

	cc := createControllers(db, session)

	auth := api.Group("/auth")
	auth.Post("/login", cc.authController.Login)
	auth.Post("/logout", cc.authController.Logout)
	auth.Post("/register-email", cc.authController.RegisterEmail)
	auth.Post("/register-password", cc.authController.RegisterPassword)
	auth.Post("/verify-email", cc.authController.VerifyEmailAndCreateUser)

	test := api.Group("/test").Use(AuthMiddleware(session))
	test.Post("/hello", func(c *fiber.Ctx) error { return c.SendString("This works!") }) // ! remove
}
