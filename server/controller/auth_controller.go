package controller

import (
	"task-scheduler/service"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

type AuthController struct {
	userService *service.UserService
	session     *session.Store
}

func CreateAuthController(us *service.UserService, session *session.Store) *AuthController {
	return &AuthController{
		userService: us,
		session:     session,
	}
}

func (ac *AuthController) Login(c *fiber.Ctx) error {

	type Request struct {
		Email    string `json:"email" validate:"required,email,max=511"`
		Password string `json:"password" validate:"required"`
	}

	req, err := ParseAndValidate[Request](c)
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
	err = sess.Save()
	if err != nil {
		return err
	}

	return c.JSON(&fiber.Map{
		"id":    user.Id,
		"email": user.Email,
		"name":  user.Name,
	})
}

func (ac *AuthController) Logout(c *fiber.Ctx) error {

	sess, err := ac.session.Get(c)
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

func (ac *AuthController) RegisterEmail(c *fiber.Ctx) error {

	type Request struct {
		Email string `json:"email" validate:"required,email,max=511"`
	}

	req, err := ParseAndValidate[Request](c)
	if err != nil {
		return err
	}

	sess, err := ac.session.Get(c)
	if err != nil {
		return err
	}

	sess.Reset()
	sess.SetExpiry(30 * time.Minute)

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

	err = sess.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusCreated)
}

func (ac *AuthController) RegisterPassword(c *fiber.Ctx) error {

	type Request struct {
		Password string `json:"password" validate:"required,min=10"`
	}

	req, err := ParseAndValidate[Request](c)
	if err != nil {
		return err
	}

	sess, err := ac.session.Get(c)
	if err != nil {
		return err
	}

	err = ac.userService.SetRegisterPassword(req.Password, sess)
	if err != nil {
		return err
	}

	err = sess.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusCreated)
}

func (ac *AuthController) VerifyEmailAndCreateUser(c *fiber.Ctx) error {

	type Request struct {
		VerificationCode string `json:"verificationCode" validate:"required,len=6"`
	}

	req, err := ParseAndValidate[Request](c)
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
