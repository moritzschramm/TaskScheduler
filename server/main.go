package main

import (
	"os"
	"task-scheduler/controller"
	"task-scheduler/infrastructure"

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

	// * load env vars
	godotenv.Load(".env")

	// * create new server
	app := fiber.New(fiber.Config{
		Prefork:       true,
		CaseSensitive: true,
		StrictRouting: true,
	})

	// * register middleware
	app.Use(logger.New())
	app.Use(recover.New(recover.Config{
		EnableStackTrace: true, // ! only for dev; NOT FOR PROD -> TODO change
	}))
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

	// * connect database pool
	db := infrastructure.NewDatabaseConnection()
	db.Open(os.Getenv("POSTGRES_DSN"))
	defer db.Close()

	// * connect to key value store
	store := infrastructure.NewKeyValueStore()
	store.Open(os.Getenv("REDIS_ADDR"))
	defer store.Close()

	// * register routes for API
	api := app.Group("/v").Group("/0") // prefix all routes with /v/0 "version 0"
	controller.SetupRoutes(&api, db, store)

	// * start listening on port defined in .env
	app.Listen(os.Getenv("SERVER_ADDR"))
}
