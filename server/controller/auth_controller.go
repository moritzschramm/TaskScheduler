package controller

import (
	"log"
	"task-scheduler/domain"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
	//"github.com/go-playground/validator/v10"	// TODO implement validator to check structs for correctness
)

type (
	AuthController interface {
		Login(c *fiber.Ctx) error
		RegisterEmail(c *fiber.Ctx) error
		RegisterUser(c *fiber.Ctx) error
		VerifyEmailAndCreateUser(c *fiber.Ctx) error
	}

	authController struct {
		userService domain.UserService
		session     *session.Store
	}

	loginReq struct {
		Email    string `json:"email" validate:"required,email,max=512"`
		Password string `json:"password" validate:"required"`
	}

	registerEmailReq struct {
		Email string `json:"email" validate:"required,email,max=512"`
	}

	registerUserReq struct {
		RegisterId string `json:"registerId" validate:"required,uuid4"`
		Password   string `json:"password" validate:"required,min=10"`
		Firstname  string `json:"firstname" validate:"required,max=256"`
		Lastname   string `json:"lastname" validate:"required,max=256"`
	}

	verifyEmailAndCreateUserReq struct {
		RegisterId string `json:"registerId" validate:"required,uuid4"`
		Code       string `json:"password" validate:"required,len=10"`
	}
)

// constructor
func NewAuthController(us domain.UserService, session *session.Store) AuthController {
	return &authController{
		userService: us,
		session:     session,
	}
}

func (ac *authController) Login(c *fiber.Ctx) error {

	// TODO create session

	req := new(loginReq)

	if err := c.BodyParser(req); err != nil {
		log.Printf("Login: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	match, err := ac.userService.CheckLogin(req.Email, req.Password)
	if err != nil {
		log.Printf("Login: error checking login: %v\n", err)
		return c.SendStatus(400)
	}

	if !match {
		return c.SendStatus(401)
	}

	return c.SendStatus(200)
}

func (ac *authController) RegisterEmail(c *fiber.Ctx) error {

	req := new(registerEmailReq)

	if err := c.BodyParser(req); err != nil {
		log.Printf("RegisterEmail: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	emailExists, err := ac.userService.CheckEmailExists(req.Email)
	if err != nil {
		log.Printf("RegisterEmail: error checking if email exists: %v\n", err)
		return c.SendStatus(404)
	}

	if emailExists {
		return c.SendStatus(401)
	}

	registerId, err := ac.userService.SetRegisterEmail(req.Email)
	if err != nil {
		log.Printf("RegisterEmail: error storing email: %v\n", err)
		return c.SendStatus(400)
	}

	return c.Status(201).JSON(&fiber.Map{
		"registerId": registerId,
	})
}

func (ac *authController) RegisterUser(c *fiber.Ctx) error {

	req := new(registerUserReq)

	if err := c.BodyParser(req); err != nil {
		log.Printf("RegisterUser: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	log.Printf("RegisterUser: %v\n", req)

	err := ac.userService.SetRegisterUserData(req.RegisterId, req.Firstname, req.Lastname, req.Password)
	if err != nil {
		log.Printf("RegisterUser: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	return c.SendStatus(201)
}

func (ac *authController) VerifyEmailAndCreateUser(c *fiber.Ctx) error {

	req := new(verifyEmailAndCreateUserReq)

	if err := c.BodyParser(req); err != nil {
		log.Printf("VerifyEmail: error parsing body: %v\n", err)
		return c.SendStatus(400)
	}

	verified, user, err := ac.userService.VerifyEmailAndGetTempUser(req.RegisterId, req.Code)
	if err != nil {
		log.Printf("VerifyEmail: error verifying email: %v\n", err)
		return c.SendStatus(400)
	}

	if !verified {
		return c.SendStatus(401)
	}

	err = ac.userService.CreateUser(user)
	if err != nil {
		log.Printf("VerifyEmail: error creating user: %v\n", err)
		return c.SendStatus(400)
	}

	return c.SendStatus(200)
}
