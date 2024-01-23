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
		Storage: store,
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
		AllowHeaders:     "Origin, Content-Type, Accept",
		AllowCredentials: true,
		MaxAge:           3600, // 1 hour caching
	}))
	// TODO implement csrf (in client!)
	/*app.Use(csrf.New(csrf.Config{
		KeyLookup:         "header:" + csrf.HeaderName,
		CookieName:        "__Host-csrf_",
		CookieSameSite:    "Lax",
		CookieSecure:      os.Getenv("DEV_ENV") != "true",
		CookieSessionOnly: true,
		CookieHTTPOnly:    true,
		Expiration:        1 * time.Hour,
		KeyGenerator:      utils.UUIDv4,
		Extractor:         csrf.CsrfFromHeader(csrf.HeaderName),
		Session:           session,
		SessionKey:        "fiber.csrf.token",
		HandlerContextKey: "fiber.csrf.handler",
	}))*/

	// * register routes for API
	api := app.Group("/api") // prefix all routes with /api
	controller.SetupRoutes(api, db, store, session)

	// * start listening on port defined in .env
	wg.Wait()
	app.Listen(os.Getenv("SERVER_ADDR"))
}
