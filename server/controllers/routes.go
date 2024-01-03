package controllers

import (
	"github.com/gofiber/fiber/v2"
)

func SetupRoutes(router *fiber.Router) {

	api := *router

	api.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API version 0.1")
	})

	auth := api.Group("/auth")
	auth.Post("/login", Login)
	auth.Post("/register-email", RegisterEmail)
	auth.Post("/register-user-data", RegisterUser)
	auth.Post("/verify-email", VerifyEmail)
}
