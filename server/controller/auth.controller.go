package controller

import (
	"task-scheduler/middleware"
	"task-scheduler/service"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

type AuthController struct {
	userService *service.UserService
}

func CreateAuthController(us *service.UserService) *AuthController {
	return &AuthController{
		userService: us,
	}
}

func (ac *AuthController) Login(c *fiber.Ctx) error {

	store, ok := c.Locals(middleware.StoreKey).(*session.Store)
	if !ok {
		return middleware.SessionError
	}

	// check if request is trying to brute-force access
	userIdentifier := c.IP() + c.Get("User-Agent")

	attempts, err := ac.userService.GetBruteForceAttempts(userIdentifier, store)

	if attempts >= 3 {
		return c.Status(fiber.StatusTooManyRequests).JSON(&fiber.Map{
			"err": "Too many attempts. Please try again later.",
		})
	}

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

	// user not found or password and hash did not match
	if user == nil {
		ac.userService.IncreaseBruteForceAttempts(userIdentifier, attempts, store)
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"err": "Wrong email or password.",
		})
	}

	ac.userService.ResetBruteForceAttempts(userIdentifier, store)

	// credentials confirmed, create new session
	session, ok := c.Locals(middleware.SessionKey).(*session.Session)
	if !ok {
		return middleware.SessionError
	}

	session.Reset()
	session.Set(middleware.UserKey, user)
	err = session.Save()
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

	// get current session and reset it
	session, ok := c.Locals(middleware.SessionKey).(*session.Session)
	if !ok {
		return middleware.SessionError
	}

	session.Reset()
	err := session.Save()
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

	session, ok := c.Locals(middleware.SessionKey).(*session.Session)
	if !ok {
		return middleware.SessionError
	}

	session.Reset()
	session.SetExpiry(30 * time.Minute)

	emailExists, err := ac.userService.CheckEmailExists(req.Email)
	if err != nil {
		return err
	}

	if emailExists {
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"email": "Email already exists.",
		})
	}

	err = ac.userService.SetRegisterEmail(req.Email, session)
	if err != nil {
		return err
	}

	err = session.Save()
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

	session, ok := c.Locals(middleware.SessionKey).(*session.Session)
	if !ok {
		return middleware.SessionError
	}

	err = ac.userService.SetRegisterPassword(req.Password, session)
	if err != nil {
		return err
	}

	err = session.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusCreated)
}

func (ac *AuthController) VerifyEmailAndCreateUser(c *fiber.Ctx) error {

	// check if request is trying to brute-force access
	store, ok := c.Locals(middleware.StoreKey).(*session.Store)
	if !ok {
		return middleware.SessionError
	}

	userIdentifier := c.IP() + c.Get("User-Agent")

	attempts, err := ac.userService.GetBruteForceAttempts(userIdentifier, store)

	if attempts >= 3 {
		return c.Status(fiber.StatusTooManyRequests).JSON(&fiber.Map{
			"err": "Too many attempts. Please try again later.",
		})
	}

	type Request struct {
		VerificationCode string `json:"verificationCode" validate:"required,len=6"`
	}

	req, err := ParseAndValidate[Request](c)
	if err != nil {
		return err
	}

	session, ok := c.Locals(middleware.SessionKey).(*session.Session)
	if !ok {
		return middleware.SessionError
	}

	verified, user, err := ac.userService.VerifyEmailAndGetTempUser(req.VerificationCode, session)
	if err != nil {
		return err
	}

	if !verified {
		ac.userService.IncreaseBruteForceAttempts(userIdentifier, attempts, store)
		return c.Status(fiber.StatusForbidden).JSON(&fiber.Map{
			"err": "Wrong verification code.",
		})
	}

	ac.userService.ResetBruteForceAttempts(userIdentifier, store)

	err = ac.userService.CreateUser(user)
	if err != nil {
		return err
	}

	// reset session to flush out temporary user
	session.Reset()
	err = session.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusOK)
}
