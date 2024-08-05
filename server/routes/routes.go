package routes

import (
	"task-scheduler/infrastructure"
	"task-scheduler/middleware"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

func Setup(api fiber.Router,
	db infrastructure.Database,
	store *session.Store) {

	c := CreateController(db)

	// ordering is important!

	auth := api.Group("/auth").Use(middleware.SessionMiddleware(store))
	auth.Post("/login", c.auth.Login)
	auth.Post("/register-email", c.auth.RegisterEmail)
	auth.Post("/register-password", c.auth.RegisterPassword)
	auth.Post("/verify-email", c.auth.VerifyEmailAndCreateUser)
	auth.Post("/logout", c.auth.Logout).Use(middleware.AuthMiddleware())

	test := api.Group("/test").Use(middleware.SessionMiddleware(store), middleware.AuthMiddleware())
	test.Post("/hello", func(c *fiber.Ctx) error { return c.SendString("This works!") }) // ! remove
}
