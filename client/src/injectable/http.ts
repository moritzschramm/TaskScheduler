import axios from 'axios'
import type { AxiosInstance } from 'axios'
import type { InjectionKey } from 'vue'

export const axiosInstance: AxiosInstance = axios.create({
  baseURL: 'http://127.0.0.1:8080/v/0', // TODO load addr from env
  withCredentials: true,
  headers: {
    'Content-type': 'application/json',
  },
})

export const HttpClient: InjectionKey<AxiosInstance> = Symbol('http')