import request from 'supertest';
import express from 'express';
import * as satellite from 'satellite.js';
import { addHours } from 'date-fns';

// Import your app
import app from '../server';

// Mock satellite.js functions
jest.mock('satellite.js', () => ({
  propagate: jest.fn(),
  gstime: jest.fn(),
  eciToEcf: jest.fn(),
  ecfToLookAngles: jest.fn(),
  degreesLat: jest.fn(),
  degreesLong: jest.fn(),
  degreesToRadians: jest.fn(),
  twoline2satrec: jest.fn()
}));

describe('Satellite Pass Predictor API', () => {
  // Unit Tests
  describe('fetchTLE', () => {
    it('should fetch TLE data for valid satellite ID', async () => {
      const mockTLE = {
        name: 'ISS (ZARYA)',
        line1: '1 25544U 98067A   24001.50000000  .00000000  00000+0  00000+0 0    04',
        line2: '2 25544  51.6400   0.0000   0.0000   0.0000   0.0000 15.50000000    02'
      };

      global.fetch = jest.fn().mockResolvedValue({
        text: () => Promise.resolve(`${mockTLE.name}\n${mockTLE.line1}\n${mockTLE.line2}`)
      });

      const result = await fetchTLE('25544');
      expect(result).toEqual(mockTLE);
    });

    it('should use cached TLE data if available and not expired', async () => {
      const mockTLE = {
        name: 'ISS (ZARYA)',
        line1: '1 25544U...',
        line2: '2 25544...'
      };

      // Set up cache
      tleCache.set('25544', {
        tle: mockTLE,
        timestamp: Date.now()
      });

      const result = await fetchTLE('25544');
      expect(result).toEqual(mockTLE);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('calculatePasses', () => {
    it('should calculate passes correctly', () => {
      const mockSatrec = {};
      const mockObserver = {
        latitude: 0.6593,
        longitude: -2.1366,
        height: 0
      };
      const startTime = new Date();
      const endTime = addHours(startTime, 24);

      // Mock satellite.js functions
      (satellite.propagate as jest.Mock).mockReturnValue({
        position: { x: 1, y: 1, z: 1 }
      });
      (satellite.gstime as jest.Mock).mockReturnValue(0);
      (satellite.eciToEcf as jest.Mock).mockReturnValue({ x: 1, y: 1, z: 1 });
      (satellite.ecfToLookAngles as jest.Mock).mockReturnValue({
        elevation: 0.2,
        azimuth: 1.5
      });
      (satellite.degreesLat as jest.Mock).mockReturnValue(15);
      (satellite.degreesLong as jest.Mock).mockReturnValue(180);

      const passes = calculatePasses(mockSatrec, mockObserver, startTime, endTime);
      expect(passes).toBeInstanceOf(Array);
      expect(satellite.propagate).toHaveBeenCalled();
    });
  });

  // Integration Tests
  describe('POST /api/passes', () => {
    it('should return 400 for missing parameters', async () => {
      const response = await request(app)
        .post('/api/passes')
        .send({});
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Missing required parameters');
    });

    it('should return 400 for invalid coordinates', async () => {
      const response = await request(app)
        .post('/api/passes')
        .send({
          satelliteId: '25544',
          lat: '91',
          lng: '180'
        });
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Invalid coordinates');
    });

    it('should return satellite passes for valid request', async () => {
      // Mock satellite.js functions for integration test
      (satellite.twoline2satrec as jest.Mock).mockReturnValue({});
      (satellite.propagate as jest.Mock).mockReturnValue({
        position: { x: 1, y: 1, z: 1 }
      });
      
      const response = await request(app)
        .post('/api/passes')
        .send({
          satelliteId: '25544',
          lat: '37.7749',
          lng: '-122.4194'
        });
      
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body[0]).toHaveProperty('startTime');
      expect(response.body[0]).toHaveProperty('endTime');
      expect(response.body[0]).toHaveProperty('maxElevation');
    });
  });
});