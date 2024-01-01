package main

import (
	"task-scheduler/controllers"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"

	//"github.com/gofiber/fiber/v2/middleware/csrf" // TODO enable CSRF protection
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	//"github.com/gofiber/fiber/v2/middleware/session"
	//"github.com/go-playground/validator/v10"	// * check out validator package for incoming data
)

func main() {

	app := fiber.New(fiber.Config{
		Prefork:       true,
		CaseSensitive: true,
		StrictRouting: true,
	})

	app.Use(logger.New())

	app.Use(recover.New())

	app.Use(limiter.New()) // TODO check if KeyGenerator works when behind reverse proxy // TODO checkout sliding window approach

	app.Use(cors.New(cors.Config{
		AllowOrigins: "http://localhost:5173",
		AllowHeaders: "Origin, Content-Type, Accept",
		MaxAge:       3600, // 1 hour caching
	}))

	api := app.Group("/v").Group("/0") // /v/0

	auth_group := api.Group("/auth") // /v/0/auth

	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("Hello, World!")
	})

	auth_group.Get("/login", controllers.Login) // /v/0/auth/login

	app.Listen("127.0.0.1:3000")
}
