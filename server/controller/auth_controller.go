package controller

import (
	"log"
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
	RegisterId string `json:"registerId"`
	Firstname  string `json:"firstname"`
	Lastname   string `json:"lastname"`
	Password   string `json:"password"`
}
type verificationCodeReqMsg struct {
	RegisterId string `json:"registerId"`
	Code       string `json:"code"`
}

// constructor
func NewAuthController(us domain.UserService) AuthController {
	return &authController{
		userService: us,
	}
}

func (ac *authController) Login(c *fiber.Ctx) error {

	req := new(loginReqMsg)

	if err := c.BodyParser(req); err != nil {
		log.Fatalf("Login: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	if !ac.userService.CheckLogin(req.Email, req.Password) {
		return c.SendStatus(401)
	}

	return c.SendStatus(200)
}

func (ac *authController) RegisterEmail(c *fiber.Ctx) error {

	req := new(registerEmailReqMsg)

	if err := c.BodyParser(req); err != nil {
		log.Fatalf("RegisterEmail: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	registerId, err := ac.userService.RegisterEmail(req.Email)
	if err != nil {
		log.Fatalf("RegisterEmail: error storing email: %v\n", err)
		return c.SendStatus(400)
	}

	return c.Status(201).JSON(&fiber.Map{
		"registerId": registerId,
	})
}

func (ac *authController) RegisterUser(c *fiber.Ctx) error {

	req := new(registerUserReqMsg)

	if err := c.BodyParser(req); err != nil {
		log.Fatalf("RegisterUser: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	if err := ac.userService.RegisterUserData(req.RegisterId, req.Firstname, req.Lastname, req.Password); err != nil {
		log.Fatalf("RegisterUser: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	return c.SendStatus(201)
}

func (ac *authController) VerifyEmail(c *fiber.Ctx) error {

	req := new(verificationCodeReqMsg)

	if err := c.BodyParser(req); err != nil {
		log.Fatalf("VerifyEmail: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	if !ac.userService.VerifyEmail(req.RegisterId, req.Code) {
		return c.SendStatus(401)
	}

	return c.SendStatus(200)
}
