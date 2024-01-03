package main

import (
	"os"
	"task-scheduler/controllers"
	"task-scheduler/models"

	"github.com/joho/godotenv"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"

	//"github.com/gofiber/fiber/v2/middleware/csrf" // TODO enable CSRF protection
	"github.com/gofiber/fiber/v2/middleware/limiter"
	//"github.com/gofiber/fiber/v2/middleware/session"
	//"github.com/go-playground/validator/v10"	// * check out validator package for incoming data
)

func main() {

	godotenv.Load("../.env")

	app := fiber.New(fiber.Config{
		Prefork:       true,
		CaseSensitive: true,
		StrictRouting: true,
	})

	// * register standard middleware: Logging, recover, limiter, cors, csrf, session?
	app.Use(logger.New())
	app.Use(recover.New())
	app.Use(limiter.New(limiter.Config{
		// TODO check if KeyGenerator works when behind reverse proxy
		// TODO checkout sliding window approach
		SkipSuccessfulRequests: true,
	}))
	app.Use(cors.New(cors.Config{
		AllowOrigins:     "http://localhost:5173",
		AllowHeaders:     "Origin, Content-Type, Accept",
		AllowCredentials: true,
		MaxAge:           3600, // 1 hour caching
	}))

	// * create routes that are exposed from this API
	api := app.Group("/v").Group("/0") // prefix all routes with /v/0 "version 0"
	controllers.SetupRoutes(&api)

	// * connect database pool
	models.OpenDatabaseConnection()
	defer models.CloseDatabaseConnection()

	// * start listening on port defined in .env
	app.Listen(os.Getenv("SERVER_ADDR"))
}
