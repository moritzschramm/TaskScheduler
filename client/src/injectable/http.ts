import axios from 'axios'
import type { AxiosInstance } from 'axios'
import type { InjectionKey } from 'vue'

export const axiosInstance: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'X-Ts-Custom-Csrf': '1'
  }
})

export const HttpClient: InjectionKey<AxiosInstance> = Symbol('http')
