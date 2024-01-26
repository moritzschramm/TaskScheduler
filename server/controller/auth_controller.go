package controller

import (
	"task-scheduler/domain"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

type (
	AuthController interface {
		Login(c *fiber.Ctx) error
		Logout(c *fiber.Ctx) error
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
		Password  string `json:"password" validate:"required,min=10"`
		Firstname string `json:"firstname" validate:"required,max=256"`
		Lastname  string `json:"lastname" validate:"required,max=256"`
	}

	verifyEmailAndCreateUserReq struct {
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

	req, err := ParseAndValidate[loginReq](c)
	if err != nil {
		return err
	}

	user, err := ac.userService.CheckCredentials(req.Email, req.Password)
	if err != nil {
		return err
	}

	if user == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"err": "Wrong email or password.",
		})
	}

	sess, err := ac.session.Get(c)
	if err != nil {
		return err
	}

	sess.Reset()
	sess.Set("user", user)
	sess.Save()

	return c.JSON(&fiber.Map{
		"id":        user.Id,
		"email":     user.Email,
		"firstname": user.Firstname,
		"lastname":  user.Lastname,
	})
}

func (ac *authController) Logout(c *fiber.Ctx) error {

	sess, err := ac.session.Get(c)
	if err != nil {
		return err
	}

	sess.Reset()

	return c.SendStatus(fiber.StatusOK)
}

func (ac *authController) RegisterEmail(c *fiber.Ctx) error {

	req, err := ParseAndValidate[registerEmailReq](c)
	if err != nil {
		return err
	}

	sess, err := ac.session.Get(c)
	if err != nil {
		return err
	}

	sess.Reset()

	emailExists, err := ac.userService.CheckEmailExists(req.Email)
	if err != nil {
		return err
	}

	if emailExists {
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"email": "Email already exists.",
		})
	}

	err = ac.userService.SetRegisterEmail(req.Email, sess)
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusCreated)
}

func (ac *authController) RegisterUser(c *fiber.Ctx) error {

	req, err := ParseAndValidate[registerUserReq](c)
	if err != nil {
		return err
	}

	sess, err := ac.session.Get(c)
	if err != nil {
		return err
	}

	err = ac.userService.SetRegisterUserData(req.Firstname, req.Lastname, req.Password, sess)
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

	sess, err := ac.session.Get(c)
	if err != nil {
		return err
	}

	verified, user, err := ac.userService.VerifyEmailAndGetTempUser(req.VerificationCode, sess)
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

	sess.Reset()
	err = sess.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusOK)
}
