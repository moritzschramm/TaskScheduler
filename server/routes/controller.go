package routes

import (
	"task-scheduler/controller"
	"task-scheduler/infrastructure"
	"task-scheduler/repository"
	"task-scheduler/service"

	"github.com/gofiber/fiber/v2/middleware/session"
)

// this struct should contain all controllers of the application
type Controller struct {
	auth *controller.AuthController
}

func CreateController(db infrastructure.Database, session *session.Store) *Controller {

	return &Controller{
		auth: controller.CreateAuthController(service.CreateUserService(repository.CreateUserRepository(db)), session),
	}
}
