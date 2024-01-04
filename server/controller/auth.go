package controller

import (
	"task-scheduler/domain"

	"github.com/gofiber/fiber/v2"
)

type AuthController interface {
	Login(c *fiber.Ctx) error
	RegisterEmail(c *fiber.Ctx) error
	RegisterUser(c *fiber.Ctx) error
	VerifyEmail(c *fiber.Ctx) error
}

type authController struct {
	userService domain.UserService
}

// * accepted JSON format for each request
type loginReqMsg struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}
type registerEmailReqMsg struct {
	Email string `json:"email"`
}
type registerUserReqMsg struct {
	Firstname string `json:"firstname"`
	Lastname  string `json:"lastname"`
	Password  string `json:"password"`
}
type verificationCodeReqMsg struct {
	Code string `json:"code"`
}

func NewAuthController(us domain.UserService) AuthController {
	return &authController{
		userService: us,
	}
}

func (ac *authController) Login(c *fiber.Ctx) error {

	req := new(loginReqMsg)

	if err := c.BodyParser(req); err != nil {
		return err
	}

	if !ac.userService.CheckLogin(req.Email, req.Password) {
		return c.SendStatus(401)
	}

	return c.SendStatus(200)
}

func (ac *authController) RegisterEmail(c *fiber.Ctx) error {

	req := new(registerEmailReqMsg)

	if err := c.BodyParser(req); err != nil {
		return err
	}

	if err := ac.userService.RegisterEmail(req.Email); err != nil {
		return err
	}

	return c.SendStatus(201)
}

func (ac *authController) RegisterUser(c *fiber.Ctx) error {

	req := new(registerUserReqMsg)

	if err := c.BodyParser(req); err != nil {
		return err
	}

	if err := ac.userService.RegisterUserData(req.Firstname, req.Lastname, req.Password); err != nil {
		return err
	}

	return c.SendStatus(201)
}

func (ac *authController) VerifyEmail(c *fiber.Ctx) error {

	req := new(verificationCodeReqMsg)

	if err := c.BodyParser(req); err != nil {
		return err
	}

	if !ac.userService.VerifyEmail(req.Code) {
		return c.SendStatus(401)
	}

	return c.SendStatus(200)
}
