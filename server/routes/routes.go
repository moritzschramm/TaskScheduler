package routes

import (
	"task-scheduler/infrastructure"
	"task-scheduler/middleware"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

func Setup(api fiber.Router,
	db infrastructure.Database,
	session *session.Store) {

	c := CreateController(db, session)

	auth := api.Group("/auth")
	auth.Post("/login", c.auth.Login)
	auth.Post("/logout", c.auth.Logout)
	auth.Post("/register-email", c.auth.RegisterEmail)
	auth.Post("/register-password", c.auth.RegisterPassword)
	auth.Post("/verify-email", c.auth.VerifyEmailAndCreateUser)

	test := api.Group("/test").Use(middleware.AuthMiddleware(session))
	test.Post("/hello", func(c *fiber.Ctx) error { return c.SendString("This works!") }) // ! remove
}
