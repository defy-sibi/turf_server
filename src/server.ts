import express, { Request, Response, NextFunction, Router, RequestHandler } from 'express';
import { addHours, format } from 'date-fns';
import * as satellite from 'satellite.js';
import cors from 'cors';

// Type definitions
export interface TLEData {
  name: string;
  line1: string;
  line2: string;
}

interface LocationRequest {
  satelliteId: string;
  lat: string;
  lng: string;
}

export interface SatellitePass {
  startTime: string;
  endTime: string;
  maxElevation: number;
  startAz: number;
  endAz: number;
  duration: number;
}

export interface Observer {
  latitude: number;
  longitude: number;
  height: number;
}

export const app = express();
app.use(cors());
app.use(express.json());

const tleCache = new Map<string, { tle: TLEData; timestamp: number }>();
const TLE_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function fetchTLE(satelliteId: string): Promise<TLEData> {
  const cached = tleCache.get(satelliteId);
  if (cached && Date.now() - cached.timestamp < TLE_CACHE_DURATION) {
    return cached.tle;
  }

  try {
    const response = await fetch(
      `https://celestrak.com/NORAD/elements/gp.php?CATNR=${satelliteId}&FORMAT=TLE`
    );
    const data = await response.text();
    const lines = data.split('\n');
    
    const tle = {
      name: lines[0].trim(),
      line1: lines[1].trim(),
      line2: lines[2].trim()
    };

    tleCache.set(satelliteId, {
      tle,
      timestamp: Date.now()
    });

    return tle;
  } catch (error) {
    throw new Error(`Failed to fetch TLE data: ${error}`);
  }
}

function calculatePasses(
  satrec: satellite.SatRec,
  observer: Observer,
  startTime: Date,
  endTime: Date
): SatellitePass[] {
  console.log('Starting pass calculation with:', {
    observer,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString()
  });
  
  const passes: SatellitePass[] = [];
  let currentPass: Partial<SatellitePass> | null = null;
  
  for (let date = new Date(startTime); date <= endTime; date.setMinutes(date.getMinutes() + 1)) {
    const positionAndVelocity = satellite.propagate(satrec, date);
    const gmst = satellite.gstime(date);
    
    if (!positionAndVelocity.position || typeof positionAndVelocity.position === 'boolean') {
      continue;
    }

    const positionEcf = satellite.eciToEcf(positionAndVelocity.position, gmst);
    const lookAngles = satellite.ecfToLookAngles(observer, positionEcf);

    const elevation = satellite.degreesLat(lookAngles.elevation);
    const rawAzimuth = lookAngles.azimuth;
    const azimuth = ((satellite.degreesLong(
      ((rawAzimuth + Math.PI) % (2 * Math.PI)) - Math.PI
    ) + 360) % 360);

    if (elevation > 10) {
      if (!currentPass) {
        currentPass = {
          startTime: date.toISOString(),
          startAz: azimuth,
          maxElevation: elevation
        };
      }
      if (elevation > (currentPass.maxElevation || 0)) {
        currentPass.maxElevation = elevation;
      }
    } else if (currentPass) {
      currentPass.endTime = date.toISOString();
      currentPass.endAz = azimuth;
      currentPass.duration = 
        (new Date(currentPass.endTime).getTime() - new Date(currentPass.startTime!).getTime()) / 1000;
      passes.push(currentPass as SatellitePass);
      currentPass = null;
    }
  }

  return passes;
}

const passesPrediction: RequestHandler = async (req, res, next): Promise<void> => {
  try {
    const { satelliteId, lat, lng } = req.body as LocationRequest;

    if (!satelliteId || !lat || !lng) {
      res.status(400).json({ error: 'Missing required parameters' });
      return;
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }

    const tle = await fetchTLE(satelliteId);
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);

    if (!satrec) {
      res.status(400).json({ error: 'Error parsing TLE data' });
      return;
    }

    const observer = {
      latitude: satellite.degreesToRadians(latitude),
      longitude: ((longitude + 180) % 360 - 180) * Math.PI / 180,
      height: 0
    };

    const startTime = new Date();
    const endTime = addHours(startTime, 24);

    const passes = calculatePasses(satrec, observer, startTime, endTime);

    const formattedPasses = passes.map(pass => ({
      startTime: format(new Date(pass.startTime), 'yyyy-MM-dd HH:mm:ss'),
      endTime: format(new Date(pass.endTime), 'yyyy-MM-dd HH:mm:ss'),
      maxElevation: Math.round(pass.maxElevation),
      azimuthStart: Math.round(pass.startAz),
      azimuthEnd: Math.round(pass.endAz),
      duration: Math.round(pass.duration / 60)
    }));

    res.json(formattedPasses);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Full error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      res.status(500).json({ 
        error: 'Failed to calculate passes',
        details: error.message
      });
    } else {
      console.error('Unknown error:', error);
      res.status(500).json({ error: 'Failed to calculate passes' });
    }
  }
};

const router = Router();
router.post('/passes', passesPrediction);
app.use('/api', router);

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
export { fetchTLE, tleCache, calculatePasses };