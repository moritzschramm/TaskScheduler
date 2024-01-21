package controller

import (
	"log"

	"github.com/gofiber/fiber/v2"
	//"github.com/go-playground/validator/v10"	// TODO implement validator to check structs for correctness
)

// validate := validator.New()
func ParseAndValidate[Req interface{}](c *fiber.Ctx) (*Req, error) {

	req := new(Req)

	if err := c.BodyParser(req); err != nil {
		log.Printf("Error parsing body: %v\n", err)
		return req, c.SendStatus(fiber.StatusBadRequest)
	}

	//validate.Struct(req)

	return req, nil
}
