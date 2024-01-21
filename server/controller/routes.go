package controller

import (
	"task-scheduler/infrastructure"
	"task-scheduler/repository"
	"task-scheduler/service"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

type controllerContainer struct {
	authController AuthController
}

func SetupRoutes(router *fiber.Router, db infrastructure.Database, store infrastructure.Store, session *session.Store) {

	cc := newControllerContainer(db, store, session)

	api := *router

	api.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API version 0.1")
	})

	auth := api.Group("/auth")
	auth.Post("/login", cc.authController.Login)
	auth.Post("/register-email", cc.authController.RegisterEmail)
	auth.Post("/register-user-data", cc.authController.RegisterUser)
	auth.Post("/verify-email", cc.authController.VerifyEmailAndCreateUser)
}

func newControllerContainer(db infrastructure.Database, store infrastructure.Store, session *session.Store) *controllerContainer {

	return &controllerContainer{
		authController: NewAuthController(service.NewUserService(repository.NewUserRepository(db, store)), session),
	}
}
