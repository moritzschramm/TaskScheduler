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

	auth := api.Group("/auth", middleware.SessionMiddleware(store))
	auth.Post("/login", middleware.StoreMiddleware(store), c.auth.Login)
	auth.Post("/logout", middleware.AuthMiddleware(), c.auth.Logout)
	auth.Post("/register-email", c.auth.RegisterEmail)
	auth.Post("/register-password", c.auth.RegisterPassword)
	auth.Post("/verify-email", middleware.StoreMiddleware(store), c.auth.VerifyEmailAndCreateUser)

	test := api.Group("/test").Use(middleware.SessionMiddleware(store), middleware.AuthMiddleware())
	test.Post("/hello", func(c *fiber.Ctx) error { return c.SendString("This works!") }) // ! remove
}
