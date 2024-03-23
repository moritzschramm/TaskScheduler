package main

import (
	"github.com/gofiber/fiber/v2"
)

func SetupRoutes(api fiber.Router) {

	auth := api.Group("/auth")
	auth.Post("/login", RouteLogin)
	auth.Post("/logout", RouteLogout)
	auth.Post("/register-email", RouteRegisterEmail)
	auth.Post("/register-password", RouteRegisterPassword)
	auth.Post("/verify-email", RouteVerifyEmailAndCreateUser)

	test := api.Group("/test").Use(AuthMiddleware(store))
	test.Post("/hello", func(c *fiber.Ctx) error { return c.SendString("This works!") }) // ! remove
}
