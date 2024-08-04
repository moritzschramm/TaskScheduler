package controller

import (
	"task-scheduler/infrastructure"
	"task-scheduler/repository"
	"task-scheduler/service"

	"github.com/gofiber/fiber/v2/middleware/session"
)

// this struct should contain all controllers of the application
type controllerContainer struct {
	authController AuthController
}

func createControllers(db infrastructure.Database, session *session.Store) *controllerContainer {

	return &controllerContainer{
		authController: NewAuthController(service.NewUserService(repository.NewUserRepository(db)), session),
	}
}
