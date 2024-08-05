package controller

import (
	"github.com/go-playground/validator/v10"
	"github.com/gofiber/fiber/v2"
)

var validate = validator.New()

func ParseAndValidate[Request interface{}](c *fiber.Ctx) (*Request, error) {

	request := new(Request)

	// parse from context to request
	if err := c.BodyParser(request); err != nil {
		return request, err
	}

	// validate request fields
	errs := validate.Struct(request)
	if errs != nil {
		return request, errs
	}

	return request, nil
}
