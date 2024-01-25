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

	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/session"
)

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
		Storage:        store,
		CookieHTTPOnly: true,
	})

	// * create new server
	app := fiber.New(fiber.Config{
		Prefork:       true,
		CaseSensitive: true,
		StrictRouting: true,
		ErrorHandler:  GlobalErrorHandler,
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
		AllowHeaders:     "Origin, Content-Type, Accept, X-Ts-Custom-Csrf",
		AllowCredentials: true,
		MaxAge:           3600, // 1 hour caching
	}))
	app.Use(func(c *fiber.Ctx) error { // check if request has custom csrf protection header set
		// apparently it is enough for a purely ajax req/res scheme to rely on this header
		// see https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi
		if c.Get("X-Ts-Custom-Csrf") != "1" {
			return c.SendStatus(fiber.StatusForbidden)
		}
		return c.Next()
	})

	// * register routes for API
	api := app.Group("/api") // prefix all routes with /api
	controller.SetupRoutes(api, db, store, session)

	// * start listening on port defined in .env
	wg.Wait()
	app.Listen(os.Getenv("SERVER_ADDR"))
}
