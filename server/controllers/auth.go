package controllers

import (
	"task-scheduler/models"

	"github.com/gofiber/fiber/v2"
)

func Login(c *fiber.Ctx) error {

	user := models.QueryUser()

	return c.JSON(user)
}
