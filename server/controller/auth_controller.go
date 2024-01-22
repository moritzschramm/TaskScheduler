package controller

import (
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
		RegisterId       string `json:"registerId" validate:"required,uuid4"`
		VerificationCode string `json:"verificationCode" validate:"required,len=10"`
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
		return err
	}

	if !match {
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"err": "Wrong email or password.",
		})
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
		return err
	}

	if emailExists {
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"email": "Email alreadyd exists.",
		})
	}

	registerId, err := ac.userService.SetRegisterEmail(req.Email)
	if err != nil {
		return err
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

	err = ac.userService.SetRegisterUserData(req.RegisterId, req.Firstname, req.Lastname, req.Password)
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusCreated)
}

func (ac *authController) VerifyEmailAndCreateUser(c *fiber.Ctx) error {

	req, err := ParseAndValidate[verifyEmailAndCreateUserReq](c)
	if err != nil {
		return err
	}

	verified, user, err := ac.userService.VerifyEmailAndGetTempUser(req.RegisterId, req.VerificationCode)
	if err != nil {
		return err
	}

	if !verified {
		return c.Status(fiber.StatusForbidden).JSON(&fiber.Map{
			"err": "Wrong verification code.",
		})
	}

	err = ac.userService.CreateUser(user)
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusOK)
}
