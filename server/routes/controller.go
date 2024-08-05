package routes

import (
	"task-scheduler/controller"
	"task-scheduler/infrastructure"
	"task-scheduler/repository"
	"task-scheduler/service"
)

// this struct should contain all controllers of the application
type Controller struct {
	auth *controller.AuthController
}

func CreateController(db infrastructure.Database) *Controller {

	return &Controller{
		auth: controller.CreateAuthController(service.CreateUserService(repository.CreateUserRepository(db))),
	}
}
