package controller

import (
	"task-scheduler/infrastructure"
	"task-scheduler/repository"
	"task-scheduler/service"

	"github.com/gofiber/fiber/v2"
)

type controllerContainer struct {
	authController AuthController
}

func SetupRoutes(router *fiber.Router) {

	cc := newControllerContainer()

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

func newControllerContainer() *controllerContainer {

	return &controllerContainer{
		authController: NewAuthController(service.NewUserService(repository.NewUserRepository(infrastructure.DB))),
	}
}
