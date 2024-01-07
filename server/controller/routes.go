package controller

import (
	"task-scheduler/infrastructure"
	"task-scheduler/repository"
	"task-scheduler/service"

	"github.com/gofiber/fiber/v2"
)

func SetupRoutes(router *fiber.Router, db infrastructure.Database, store infrastructure.Store) {

	cc := newControllerContainer(db, store)

	api := *router

	api.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("API version 0.1")
	})

	auth := api.Group("/auth")
	auth.Post("/login", cc.authController.Login)
	auth.Post("/register-email", cc.authController.RegisterEmail)
	auth.Post("/register-user-data", cc.authController.RegisterUser)
	auth.Post("/verify-email", cc.authController.VerifyEmail)
}

type controllerContainer struct {
	authController AuthController
}

func newControllerContainer(db infrastructure.Database, store infrastructure.Store) *controllerContainer {

	return &controllerContainer{
		authController: NewAuthController(service.NewUserService(repository.NewUserRepository(db, store))),
	}
}
