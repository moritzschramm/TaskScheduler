package main

import (
	"github.com/alexedwards/argon2id"

	"github.com/gofiber/fiber/v2"
)

type loginReq struct {
	Email    string `json:"email" validate:"required,email,max=511"`
	Password string `json:"password" validate:"required"`
}

func RouteLogin(c *fiber.Ctx) error {

	req, err := ParseAndValidate[loginReq](c)
	if err != nil {
		return err
	}

	user, err := checkCredentials(req.Email, req.Password)
	if err != nil {
		return err
	}

	if user == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"err": "Wrong email or password.",
		})
	}

	session, err := store.Get(c)
	if err != nil {
		return err
	}

	session.Reset()
	session.Set("user", user)
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

func RouteLogout(c *fiber.Ctx) error {

	session, err := store.Get(c)
	if err != nil {
		return err
	}

	session.Reset()
	err = session.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusOK)
}


func checkCredentials(email, password string) (*User, error) {
	// TODO save IP to block after 3 attempts -> in service

	user, err := getUserByEmail(email)
	if err != nil {
		return nil, nil // no hash found
	}

	match, err := argon2id.ComparePasswordAndHash(password, user.PasswordHash)
	if err != nil {
		return nil, err
	}

	if match {
		return user, nil
	}

	return nil, nil
}

func getUserByEmail(email string) (*User, error) {

	user := new(User)

	err := db.QueryRow("select u.id, u.email, u.name, u.passwordhash from users as u where u.email=$1", email).Scan(
		&user.Id,
		&user.Email,
		&user.Name,
		&user.PasswordHash,
	)
	if err != nil {
		return nil, err
	}

	return user, nil
}
