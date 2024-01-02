package controllers

import (
	"github.com/gofiber/fiber/v2"
)

func SetupRoutes(router *fiber.Router) {

	api := *router

	auth_group := api.Group("/auth")

	api.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("Hello, World!")
	})

	auth_group.Get("/login", Login)
}
