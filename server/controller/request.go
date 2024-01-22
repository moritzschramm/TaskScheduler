package controller

import (
	"github.com/go-playground/validator/v10"
	"github.com/gofiber/fiber/v2"
)

var validate = validator.New()

func ParseAndValidate[Req interface{}](c *fiber.Ctx) (*Req, error) {

	req := new(Req)

	if err := c.BodyParser(req); err != nil {
		return req, err
	}

	errs := validate.Struct(req)
	if errs != nil {
		return req, errs
	}

	return req, nil
}
