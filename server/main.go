package main

import (
	"os"
	"sync"
	"task-scheduler/controller"
	"task-scheduler/infrastructure"

	"github.com/joho/godotenv"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"

	//"github.com/gofiber/fiber/v2/middleware/csrf" // TODO enable CSRF protection
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/session"
)

type GlobalErrorHandlerResp struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

func main() {

	// * load env vars
	godotenv.Load(".env")

	var wg sync.WaitGroup

	// * connect database pool
	db := infrastructure.NewDatabaseConnection(&wg)
	go db.Open(os.Getenv("POSTGRES_DSN"))
	defer db.Close()

	// * connect to key value store
	store := infrastructure.NewKeyValueStore(&wg)
	go store.Open(os.Getenv("REDIS_ADDR"))
	defer store.Close()

	// * create session storage
	session := session.New(session.Config{
		Storage: store,
	})

	// * create new server
	app := fiber.New(fiber.Config{
		Prefork:       true,
		CaseSensitive: true,
		StrictRouting: true,
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			return c.Status(fiber.StatusBadRequest).JSON(GlobalErrorHandlerResp{
				Success: false,
				Message: err.Error(), // TODO check if **all** errors should be given to user
			})
			// TODO create custom error messages that can (and should) be parsed by client
		},
	})

	// * register middleware
	app.Use(logger.New())
	app.Use(recover.New(recover.Config{
		EnableStackTrace: os.Getenv("DEV_ENV") == "true",
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

	// * register routes for API
	api := app.Group("/api") // prefix all routes with /api
	controller.SetupRoutes(&api, db, store, session)

	// * start listening on port defined in .env
	wg.Wait()
	app.Listen(os.Getenv("SERVER_ADDR"))
}
