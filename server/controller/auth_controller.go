package controller

import (
	"log"
	"task-scheduler/domain"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
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

	req, err := ParseAndValidate[loginReq](c)
	if err != nil {
		return err
	}

	match, err := ac.userService.CheckLogin(req.Email, req.Password)
	if err != nil {
		log.Printf("Login: error checking login: %v\n", err)
		return c.SendStatus(fiber.StatusBadRequest)
	}

	if !match {
		return c.SendStatus(fiber.StatusUnauthorized)
	}

	return c.SendStatus(fiber.StatusOK)
}

func (ac *authController) RegisterEmail(c *fiber.Ctx) error {

	req, err := ParseAndValidate[registerEmailReq](c)
	if err != nil {
		return err
	}

	emailExists, err := ac.userService.CheckEmailExists(req.Email)
	if err != nil {
		log.Printf("RegisterEmail: error checking if email exists: %v\n", err)
		return c.SendStatus(fiber.StatusNotFound)
	}

	if emailExists {
		return c.SendStatus(fiber.StatusForbidden)
	}

	registerId, err := ac.userService.SetRegisterEmail(req.Email)
	if err != nil {
		log.Printf("RegisterEmail: error storing email: %v\n", err)
		return c.SendStatus(fiber.StatusBadRequest)
	}

	return c.Status(fiber.StatusCreated).JSON(&fiber.Map{
		"registerId": registerId,
	})
}

func (ac *authController) RegisterUser(c *fiber.Ctx) error {

	req, err := ParseAndValidate[registerUserReq](c)
	if err != nil {
		return err
	}

	log.Printf("RegisterUser: %v\n", req)

	err = ac.userService.SetRegisterUserData(req.RegisterId, req.Firstname, req.Lastname, req.Password)
	if err != nil {
		log.Printf("RegisterUser: error parsing body: %v\n", err)
		return c.SendStatus(fiber.StatusBadRequest)
	}

	return c.SendStatus(fiber.StatusCreated)
}

func (ac *authController) VerifyEmailAndCreateUser(c *fiber.Ctx) error {

	req, err := ParseAndValidate[verifyEmailAndCreateUserReq](c)
	if err != nil {
		return err
	}

	verified, user, err := ac.userService.VerifyEmailAndGetTempUser(req.RegisterId, req.Code)
	if err != nil {
		log.Printf("VerifyEmail: error verifying email: %v\n", err)
		return c.SendStatus(fiber.StatusBadRequest)
	}

	if !verified {
		return c.SendStatus(fiber.StatusForbidden)
	}

	err = ac.userService.CreateUser(user)
	if err != nil {
		log.Printf("VerifyEmail: error creating user: %v\n", err)
		return c.SendStatus(fiber.StatusBadRequest)
	}

	return c.SendStatus(fiber.StatusOK)
}
