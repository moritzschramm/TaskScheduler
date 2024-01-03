package controllers

import (
	"task-scheduler/models"

	"github.com/gofiber/fiber/v2"
)

func Login(c *fiber.Ctx) error {

	credentials := new(models.Credentials)

	if err := c.BodyParser(credentials); err != nil {
		return err
	}

	if !models.CheckLogin(credentials) { // login attempt failed
		return c.SendStatus(401) // TODO save IP to block after 3 attempts
	}

	// TODO create user session

	return c.SendStatus(200)
}

func RegisterEmail(c *fiber.Ctx) error {

	registerEmailRequest := new(models.RegisterEmailRequest)

	if err := c.BodyParser(registerEmailRequest); err != nil {
		return err
	}

	// TODO save in redis or something

	return c.SendStatus(201)
}

func RegisterUser(c *fiber.Ctx) error {

	registerUserRequest := new(models.RegisterUserRequest)

	if err := c.BodyParser(registerUserRequest); err != nil {
		return err
	}

	models.StoreUser(registerUserRequest)
	// TODO save user data

	return c.SendStatus(201)
}

func VerifyEmail(c *fiber.Ctx) error {

	verificationCodeRequest := new(models.VerificationCodeRequest)

	if err := c.BodyParser(verificationCodeRequest); err != nil {
		return err
	}

	// TODO check code

	return c.SendStatus(200)
}
